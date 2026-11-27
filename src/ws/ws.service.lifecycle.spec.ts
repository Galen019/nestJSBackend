/**
 * Unit suite for WsService shutdown draining.
 *
 * - drain: sessions close with 1001, claims release, and new connections fail
 * - settling: claim releases and disconnect trackers both block drain completion
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWsServiceHarness,
  type WsServiceHarness,
} from '../../test/ws-service-test.helper';
import {
  createSocketFake,
  futureExpiryMs,
  requireClientId,
  requireUserId,
} from '../../test/ws-test.helper';

describe('WsService shutdown drain', () => {
  let harness: WsServiceHarness;

  beforeEach(async () => {
    harness = await createWsServiceHarness();
  });

  afterEach(async () => {
    await harness.module.close();
    vi.restoreAllMocks();
  });

  it('drains sessions and rejects new connections', async () => {
    const first = createSocketFake();
    const second = createSocketFake();
    harness.service.handleConnection({
      socket: first.socket,
      userId: requireUserId('user-1'),
      clientId: requireClientId('client-1'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });
    harness.service.handleConnection({
      socket: second.socket,
      userId: requireUserId('user-2'),
      clientId: requireClientId('client-2'),
      expiresAt: futureExpiryMs(),
    });

    await harness.service.onModuleDestroy();

    expect(first.mocks.close).toHaveBeenCalledWith(
      1001,
      'server shutting down',
    );
    expect(second.mocks.close).toHaveBeenCalledWith(
      1001,
      'server shutting down',
    );
    expect(harness.cluster.releaseClient).toHaveBeenCalledWith(
      requireClientId('client-1'),
      'claim-1',
    );
    expect(harness.tracker.handleDisconnect).toHaveBeenCalledTimes(2);
    expect(harness.service.getSessionCount()).toBe(0);

    const rejected = createSocketFake();
    expect(
      harness.service.handleConnection({
        socket: rejected.socket,
        userId: requireUserId('user-3'),
        clientId: requireClientId('client-3'),
        expiresAt: futureExpiryMs(),
      }),
    ).toEqual({ kind: 'rejected' });
    expect(rejected.mocks.close).toHaveBeenCalledWith(
      1008,
      'server shutting down',
    );
  });

  it('waits for claim releases before drain resolves', async () => {
    let finishRelease: (() => void) | undefined;
    harness.cluster.releaseClient.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    harness.service.handleConnection({
      socket: createSocketFake().socket,
      userId: requireUserId('user-1'),
      clientId: requireClientId('client-1'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });

    let drained = false;
    const drain = harness.service.onModuleDestroy();
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishRelease?.();
    await drain;
    expect(drained).toBe(true);
  });

  it('waits for slow disconnect trackers before drain resolves', async () => {
    let finishDisconnect: (() => void) | undefined;
    harness.tracker.handleDisconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    harness.service.handleConnection({
      socket: createSocketFake().socket,
      userId: requireUserId('user-1'),
      clientId: requireClientId('client-1'),
      expiresAt: futureExpiryMs(),
    });

    let drained = false;
    const drain = harness.service.onModuleDestroy();
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishDisconnect?.();
    await drain;
    expect(drained).toBe(true);
  });
});
