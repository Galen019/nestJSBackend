/**
 * Unit suite for WsGateway with mocked WsService, verifier, and cluster.
 *
 * - connection: parses identity, claims the client, and delegates with the
 *   verified expiry plus claim token, then awaits tracker fan-out
 * - auth: closes 1008 on missing/invalid token, missing sub, or sub mismatch
 * - claims: a lost or failed claim closes 1008 without registering a session
 * - missing ids: rejected in the gateway with 1008, never delegated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { ClusterService } from '../cluster/cluster.service';
import type { SessionSocket } from './session.interface';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Creates a structural socket stub for gateway tests.
 *
 * @return Stub socket plus its close mock.
 */
function createSocketStub(): {
  socket: SessionSocket;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi
    .fn<(code?: number, reason?: string) => void>()
    .mockReturnValue(undefined);
  const socket: SessionSocket = {
    readyState: WebSocket.OPEN,
    on: (): void => undefined,
    send: (): void => undefined,
    close: (code?: number, reason?: string): void => {
      close(code, reason);
    },
    terminate: (): void => undefined,
  };
  return { socket, close };
}

describe('WsGateway', () => {
  let gateway: WsGateway;
  let module: TestingModule | undefined;
  let service: {
    handleConnection: ReturnType<typeof vi.fn>;
  };
  let cluster: {
    claimClient: ReturnType<typeof vi.fn>;
    releaseClient: ReturnType<typeof vi.fn>;
  };
  let verify: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with mocked dependencies.
   *
   * - verifier resolves a payload with `sub` bound to `user-123` by default
   * - cluster claims succeed by default
   */
  async function compile(): Promise<void> {
    service = {
      handleConnection: vi.fn().mockReturnValue({
        kind: 'registered',
        pending: Promise.resolve(),
      }),
    };
    cluster = {
      claimClient: vi.fn().mockResolvedValue('claim-token'),
      releaseClient: vi.fn().mockResolvedValue(undefined),
    };
    verify = vi.fn(() => ({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
      sub: 'user-123',
    }));
    module = await Test.createTestingModule({
      providers: [
        WsGateway,
        { provide: WsService, useValue: service },
        { provide: JwtVerifierService, useValue: { verify } },
        { provide: ClusterService, useValue: cluster },
      ],
    }).compile();
    gateway = module.get<WsGateway>(WsGateway);
  }

  beforeEach(async () => {
    await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('delegates identity and claim token to the service on valid token', async () => {
    const { socket } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(verify).toHaveBeenCalledWith('good');
    expect(cluster.claimClient).toHaveBeenCalledWith('client-456');
    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: 'user-123',
      clientId: 'client-456',
      expiresAt: 9_999_999_999_000,
      claimToken: 'claim-token',
    });
  });

  it('awaits the tracker promise returned by registration', async () => {
    let resolveTracker: (() => void) | undefined;
    service.handleConnection.mockReturnValueOnce({
      kind: 'registered',
      pending: new Promise<void>((resolve) => {
        resolveTracker = resolve;
      }),
    });
    const { socket } = createSocketStub();

    let settled = false;
    const connecting = gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });
    void connecting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveTracker?.();
    await connecting;
    expect(settled).toBe(true);
  });

  it('closes with 1008 and skips the service when the token is missing', async () => {
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
    expect(cluster.claimClient).not.toHaveBeenCalled();
  });

  it('closes with 1008 when the token is invalid', async () => {
    verify.mockImplementation(() => {
      throw new Error('bad token');
    });
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=bad',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 on sub/userId mismatch', async () => {
    verify.mockReturnValue({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
      sub: 'other-user',
    });
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 when the token carries no subject', async () => {
    verify.mockReturnValue({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
    });
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 when userId/clientId are missing despite a valid token', async () => {
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes when no upgrade URL is present', async () => {
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket);

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 when another replica holds the client claim', async () => {
    cluster.claimClient.mockResolvedValueOnce(undefined);
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, 'duplicate clientId');
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 when the claim cannot be acquired', async () => {
    cluster.claimClient.mockRejectedValueOnce(new Error('redis down'));
    const { socket, close } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, 'claim failed');
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('releases a claim when local registration rejects the connection', async () => {
    service.handleConnection.mockReturnValueOnce({ kind: 'duplicate' });
    const { socket } = createSocketStub();

    await gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(cluster.releaseClient).toHaveBeenCalledWith(
      'client-456',
      'claim-token',
    );
  });
});
