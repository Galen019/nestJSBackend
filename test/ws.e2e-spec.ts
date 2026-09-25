/**
 * E2E suite for the `/ws` gateway with real WebSocket clients and JWT auth.
 *
 * - connect: valid token + matching sub registers a session
 * - auth: missing/invalid/expired token or sub mismatch closes with 1008
 * - send: server routes JSON to the right socket, false for unknown clients
 * - disconnect: session removed from the map
 * - duplicate: new socket closed, existing session kept
 * - missing params: socket closed with 1008, nothing registered
 * - message: inbound client payload is written to the debug log
 */
import { INestApplication, Logger } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { AppModule } from './../src/app.module';
import { RedisService } from './../src/redis/redis.service';
import { parseClientId, type ClientId } from './../src/ws/session.interface';
import { WsService } from './../src/ws/ws.service';
import {
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  signTestToken,
} from './auth-test.helper';

/**
 * Parses a test `clientId`, failing fast on bad literals.
 *
 * - test-setup helper, literals in this file are always valid
 * - avoids casts while satisfying the branded parameter types.
 *
 * @param value Literal client id used by the test.
 * @return The branded client id.
 */
function requireClientId(value: string): ClientId {
  const parsed = parseClientId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test clientId: ${value}`);
  }
  return parsed;
}

/**
 * Builds an authenticated query string for a WS connection.
 *
 * - signs a token with `sub` bound to `userId` unless overridden
 * - extra overrides support expired/wrong-iss negative cases.
 *
 * @param userId User id for the query and token sub.
 * @param clientId Client id for the query.
 * @param overrides Token signing overrides for negative cases.
 * @return The query string including the token.
 */
function authQuery(
  userId: string,
  clientId: string,
  overrides: Parameters<typeof signTestToken>[0] = {},
): string {
  const token = signTestToken({ sub: userId, ...overrides });
  return `userId=${encodeURIComponent(userId)}&clientId=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`;
}

describe('WsGateway (e2e)', () => {
  let app: INestApplication;
  let wsService: WsService;
  let baseUrl: string;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    process.env.JWT_PUBLIC_KEY_PATH = join(
      process.cwd(),
      'test',
      'fixtures',
      'test-public.pem',
    );
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    const redisFake = {
      ping: async () => 'PONG',
      isReady: () => true,
      getEntry: async () => null,
      set: async () => 'OK',
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue(redisFake)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
    wsService = app.get<WsService>(WsService);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.terminate();
      } catch {
        // ignore teardown errors for already-closed sockets
      }
    }
    vi.restoreAllMocks();
    await app?.close();
  });

  /**
   * Opens a real client connection to `/ws` with the given query params.
   *
   * - defaults to a valid identity with a matching token sub
   * - resolves when the socket opens, tracks the socket for teardown.
   *
   * @param query Query string after `/ws`, defaults to an authed identity.
   * @return The open client socket.
   */
  function connectClient(
    query = authQuery('user-123', 'client-456'),
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(`${baseUrl}/ws?${query}`);
      client.once('open', () => {
        clients.push(client);
        resolve(client);
      });
      client.once('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Waits until the service reports the expected session count.
   *
   * - polls because gateway registration is async after socket open.
   *
   * @param expected Expected value of `getSessionCount()`.
   */
  async function waitForSessionCount(expected: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (wsService.getSessionCount() !== expected) {
          throw new Error(`Expected ${expected} sessions`);
        }
      },
      { timeout: 3000 },
    );
  }

  /**
   * Waits for the next message on a client socket.
   *
   * @param client Socket to listen on.
   * @return The raw message payload as a string.
   */
  function nextMessage(client: WebSocket): Promise<string> {
    return new Promise((resolve) => {
      client.once('message', (data: WebSocket.Data) => {
        resolve(String(data));
      });
    });
  }

  /**
   * Waits for a client socket to close.
   *
   * @param client Socket expected to close.
   * @return The numeric close code.
   */
  function waitForClose(client: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      client.once('close', (code: number) => {
        resolve(code);
      });
    });
  }

  it('registers a session with identity, socket, sequenceNumber, and heartbeatAt', async () => {
    const before = Date.now();
    await connectClient();
    await waitForSessionCount(1);

    const session = wsService.getSession(requireClientId('client-456'));
    expect(session?.userId).toBe('user-123');
    expect(session?.clientId).toBe('client-456');
    expect(session?.socket).toBeDefined();
    expect(session?.sequenceNumber).toBe(0);
    expect(session?.heartbeatAt).toBeGreaterThanOrEqual(before);
    expect(wsService.getSessionCount()).toBe(1);
  });

  it('closes connections with a missing token and registers nothing', async () => {
    const client = new WebSocket(
      `${baseUrl}/ws?userId=user-123&clientId=client-456`,
    );
    clients.push(client);
    const closeCode = waitForClose(client);

    await expect(closeCode).resolves.toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsService.getSessionCount()).toBe(0);
  });

  it('closes connections with an invalid token and registers nothing', async () => {
    const client = new WebSocket(
      `${baseUrl}/ws?userId=user-123&clientId=client-456&token=bad`,
    );
    clients.push(client);
    const closeCode = waitForClose(client);

    await expect(closeCode).resolves.toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsService.getSessionCount()).toBe(0);
  });

  it('closes connections with an expired token', async () => {
    const query = authQuery('user-123', 'client-456', { expiresIn: '-10s' });
    const client = new WebSocket(`${baseUrl}/ws?${query}`);
    clients.push(client);
    const closeCode = waitForClose(client);

    await expect(closeCode).resolves.toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsService.getSessionCount()).toBe(0);
  });

  it('closes connections on sub/userId mismatch', async () => {
    const token = signTestToken({ sub: 'other-user' });
    const client = new WebSocket(
      `${baseUrl}/ws?userId=user-123&clientId=client-456&token=${encodeURIComponent(token)}`,
    );
    clients.push(client);
    const closeCode = waitForClose(client);

    await expect(closeCode).resolves.toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsService.getSessionCount()).toBe(0);
  });

  it('routes sendToClient to the correct socket only', async () => {
    const first = await connectClient(authQuery('user-1', 'client-1'));
    const second = await connectClient(authQuery('user-2', 'client-2'));
    await waitForSessionCount(2);
    const secondMessage = nextMessage(second);
    let firstReceived = false;
    first.once('message', () => {
      firstReceived = true;
    });

    const ok = wsService.sendToClient(requireClientId('client-2'), {
      type: 'MESSAGE',
      data: 'hello',
    });

    expect(ok).toBe(true);
    await expect(secondMessage).resolves.toBe(
      JSON.stringify({ type: 'MESSAGE', data: 'hello' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(firstReceived).toBe(false);
  });

  it('returns false for an unknown client', async () => {
    await connectClient();
    await waitForSessionCount(1);

    expect(
      wsService.sendToClient(requireClientId('ghost'), { type: 'PING' }),
    ).toBe(false);
  });

  it('removes the session when the client disconnects', async () => {
    const client = await connectClient();
    await waitForSessionCount(1);

    client.close();
    await waitForSessionCount(0);

    expect(wsService.getSession(requireClientId('client-456'))).toBeUndefined();
  });

  it('closes the new socket and keeps the old session on duplicate clientId', async () => {
    await connectClient(authQuery('user-123', 'client-456'));
    await waitForSessionCount(1);
    const duplicate = new WebSocket(
      `${baseUrl}/ws?${authQuery('user-123', 'client-456')}`,
    );
    clients.push(duplicate);
    const closeCode = waitForClose(duplicate);

    await expect(closeCode).resolves.toBe(1008);
    await waitForSessionCount(1);
    expect(wsService.getSession(requireClientId('client-456'))?.userId).toBe(
      'user-123',
    );
    expect(
      wsService.sendToClient(requireClientId('client-456'), { type: 'PING' }),
    ).toBe(true);
  });

  it('closes connections with missing params and registers nothing', async () => {
    const client = new WebSocket(`${baseUrl}/ws`);
    clients.push(client);
    const closeCode = waitForClose(client);

    await expect(closeCode).resolves.toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsService.getSessionCount()).toBe(0);
  });

  it('logs the inbound message payload from the client', async () => {
    const client = await connectClient();
    await waitForSessionCount(1);
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    client.send('hello-e2e-payload');

    await vi.waitFor(
      () => {
        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringContaining('hello-e2e-payload'),
          'client-456',
        );
      },
      { timeout: 3000 },
    );
  });
});
