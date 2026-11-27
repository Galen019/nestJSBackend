/**
 * Unit suite for ClusterService with an in-memory command client fake.
 *
 * - lifecycle: connects on init and quits an open client on destroy
 * - claims: SET uses NX with the short TTL and stores the bare token
 * - release: compare-and-delete consumes the same token shape as a claim
 * - renewal: compare-and-expire reports ownership and propagates Redis errors
 */
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClusterFake } from '../../test/cluster-test.helper';
import { requireClientId } from '../../test/ws-test.helper';
import { CLAIM_TTL_SECONDS, CLUSTER_REDIS_CLIENT } from './cluster.constants';
import {
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  ClusterService,
  type ClusterCommandClient,
} from './cluster.service';

/**
 * Creates a command-client fake with mocks for every used Redis call.
 *
 * @return Fake client plus its call mocks.
 */
function createCommandFake() {
  const connect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const quit = vi.fn<() => Promise<string>>().mockResolvedValue('OK');
  const on =
    vi.fn<(event: string, listener: (err: Error) => void) => unknown>();
  const set =
    vi.fn<
      (
        key: string,
        value: string,
        options: { NX: boolean; EX: number },
      ) => Promise<string | null>
    >();
  const evalScript =
    vi.fn<
      (
        script: string,
        options: { keys: string[]; arguments: string[] },
      ) => Promise<unknown>
    >();
  let open = false;
  const client = {
    get isOpen(): boolean {
      return open;
    },
    connect,
    quit,
    on,
    set,
    eval: evalScript,
  } satisfies ClusterCommandClient;
  return {
    client,
    connect,
    quit,
    on,
    set,
    evalScript,
    setOpen: (value: boolean): void => {
      open = value;
    },
  };
}

describe('ClusterService', () => {
  let service: ClusterService;
  let module: TestingModule | undefined;
  let command: ReturnType<typeof createCommandFake>;

  beforeEach(async () => {
    command = createCommandFake();
    command.set.mockResolvedValue('OK');
    command.evalScript.mockResolvedValue(1);
    module = await Test.createTestingModule({
      providers: [
        ClusterService,
        { provide: CLUSTER_REDIS_CLIENT, useValue: command.client },
      ],
    }).compile();
    service = module.get<ClusterService>(ClusterService);
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('connects the command client on init', async () => {
    await service.onModuleInit();

    expect(command.connect).toHaveBeenCalledTimes(1);
  });

  it('quits an open client and skips a closed one on destroy', async () => {
    command.setOpen(true);
    await service.onModuleDestroy();
    expect(command.quit).toHaveBeenCalledTimes(1);

    command.setOpen(false);
    await service.onModuleDestroy();
    expect(command.quit).toHaveBeenCalledTimes(1);
  });

  it('claims a client with NX and a short fixed TTL', async () => {
    const token = await service.claimClient(requireClientId('client-1'));

    expect(token).toEqual(expect.any(String));
    expect(command.set).toHaveBeenCalledWith('ws:claim:client-1', token, {
      NX: true,
      EX: CLAIM_TTL_SECONDS,
    });
  });

  it('returns undefined when another replica wins the claim', async () => {
    command.set.mockResolvedValueOnce(null);

    await expect(
      service.claimClient(requireClientId('client-1')),
    ).resolves.toBeUndefined();
  });

  it('throws when Redis rejects a claim so the gateway can reject the socket', async () => {
    command.set.mockRejectedValueOnce(new Error('redis down'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.claimClient(requireClientId('client-1')),
    ).rejects.toThrow('redis down');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim client-1'),
    );
  });

  it('releases exactly the value that claimClient stored', async () => {
    const clientId = requireClientId('client-1');
    const token = await service.claimClient(clientId);
    if (token === undefined) {
      throw new Error('Expected a claim token');
    }

    await service.releaseClient(clientId, token);

    const stored = command.set.mock.calls[0]?.[1];
    const call = command.evalScript.mock.calls[0];
    expect(stored).toBe(token);
    expect(call?.[0]).toBe(RELEASE_SCRIPT);
    expect(call?.[0]).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    expect(call?.[1]).toEqual({
      keys: ['ws:claim:client-1'],
      arguments: [token],
    });
  });

  it('releases the bare stored token when RELEASE_SCRIPT is executed', async () => {
    const fake = createClusterFake();
    const scriptedModule = await Test.createTestingModule({
      providers: [
        ClusterService,
        { provide: CLUSTER_REDIS_CLIENT, useValue: fake.client },
      ],
    }).compile();
    try {
      const scripted = scriptedModule.get<ClusterService>(ClusterService);
      const clientId = requireClientId('client-1');
      const token = await scripted.claimClient(clientId);
      if (token === undefined) {
        throw new Error('Expected a claim token');
      }
      const key = 'ws:claim:client-1';
      expect(fake.store.get(key)).toBe(token);

      await scripted.releaseClient(clientId, token);

      expect(fake.store.has(key)).toBe(false);
    } finally {
      await scriptedModule.close();
    }
  });

  it('absorbs release failures so shutdown never stalls', async () => {
    command.evalScript.mockRejectedValueOnce(new Error('redis down'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.releaseClient(requireClientId('client-1'), 'claim-token'),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release client-1'),
    );
  });

  it('renews a claim with the stored token and the same TTL', async () => {
    await expect(
      service.renewClient(requireClientId('client-1'), 'claim-token'),
    ).resolves.toBe(true);

    const call = command.evalScript.mock.calls[0];
    expect(call?.[0]).toBe(RENEW_SCRIPT);
    expect(call?.[1]).toEqual({
      keys: ['ws:claim:client-1'],
      arguments: ['claim-token', String(CLAIM_TTL_SECONDS)],
    });
  });

  it('reports a lost claim so the caller can end the session', async () => {
    command.evalScript.mockResolvedValueOnce(0);

    await expect(
      service.renewClient(requireClientId('client-1'), 'claim-token'),
    ).resolves.toBe(false);
  });

  it('propagates renewal failures instead of silently losing ownership', async () => {
    command.evalScript.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.renewClient(requireClientId('client-1'), 'claim-token'),
    ).rejects.toThrow('redis down');
  });
});
