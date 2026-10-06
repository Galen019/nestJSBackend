/**
 * Unit suite for WsService with structurally-typed socket fakes.
 *
 * - connect: session added with userId/clientId/socket/presenceToken
 * - trackers: registered fans out connect with the token and user total, never on duplicate/rejected
 * - isolation: a rejecting or throwing tracker never blocks siblings, failures log at warn
 * - lookup: getSession returns the entry, getSessionCount tracks active sessions
 * - send: routes JSON through the right socket, false for unknown/closed clients
 * - broadcast: sendToUser publishes one envelope to user:{userId}, failures
 *   warn and reject; sendToLocalUser fans out to every local session of the
 *   user except the excluded origin client
 * - close: the registration close listener removes the session and fans out disconnect by token
 * - duplicate: new socket closed with 1008, existing session kept
 * - message: inbound payload is logged at debug with userId/clientId attribution
 * - sendMessage: valid frames route verbatim via `sendToUser` excluding
 *   origin; noise is ignored silently while invalid targets and delivery
 *   failures warn plus NACK, socket always stays open
 * - frame shape: `parseInboundFrame` owns the protocol contract, covered in
 *   `session.interface.spec.ts` without sockets
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createPublisherFake,
  type PublisherFake,
} from '../../test/publisher-test.helper';
import {
  createSocketFake,
  fireClose,
  fireError,
  fireMessage,
  requireClientId,
  requireUserId,
} from '../../test/ws-test.helper';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  parseClientId,
  parseUserId,
  SEND_MESSAGE_ERROR_OP,
  SEND_MESSAGE_OP,
  SESSION_TRACKERS,
  type SessionLifecycleEvent,
  type SessionTracker,
} from './session.interface';
import type { SocketFake } from '../../test/ws-test.helper';
import { WS_CLOSE_POLICY_VIOLATION, WsService } from './ws.service';

/**
 * Creates a `ws` oversize error shaped like the receiver rejection.
 *
 * - carries the `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` code
 * - matches what `ws` emits before closing with 1009.
 *
 * @return Error with the oversize marker.
 */
function createOversizeError(): Error {
  const err = new RangeError('Max payload size exceeded');
  Object.assign(err, { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
  return err;
}

describe('WsService', () => {
  let service: WsService;
  let module: TestingModule | undefined;
  let publisher: PublisherFake;
  let tracker: {
    handleConnect: ReturnType<
      typeof vi.fn<(event: SessionLifecycleEvent) => Promise<void>>
    >;
    handleDisconnect: ReturnType<
      typeof vi.fn<(event: SessionLifecycleEvent) => Promise<void>>
    >;
  };

  /**
   * Builds a testing module with a fresh WsService.
   *
   * - provides a mocked tracker list so no presence or topic calls happen
   * - provides a mocked publisher so broadcasts never touch Redis
   * - extra trackers run before the observed one to prove failure isolation
   * - tracks the module so it can be closed after each test.
   *
   * @param extraTrackers Additional trackers placed before the observed one.
   */
  async function compile(
    extraTrackers: SessionTracker[] = [],
  ): Promise<WsService> {
    tracker = {
      handleConnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockResolvedValue(undefined),
      handleDisconnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    publisher = createPublisherFake();
    module = await Test.createTestingModule({
      providers: [
        WsService,
        { provide: SESSION_TRACKERS, useValue: [...extraTrackers, tracker] },
        { provide: REDIS_CLIENT, useValue: publisher },
      ],
    }).compile();
    return module.get<WsService>(WsService);
  }

  beforeEach(async () => {
    service = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  /**
   * Connects one sender through the production registration path.
   *
   * @return The fake socket wired to `handleMessage`.
   */
  function connectSender(): SocketFake {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    return fake;
  }

  it('adds a session when a client connects', () => {
    const { socket } = createSocketFake();

    const result = service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(result).toEqual({ kind: 'registered' });
    expect(service.getSessionCount()).toBe(1);
  });

  it('stores the correct userId, clientId, socket, and presenceToken', () => {
    const { socket } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    const session = service.getSession(requireClientId('client-456'));
    if (session === undefined) {
      throw new Error('Expected session to exist');
    }
    expect(session.userId).toBe('user-123');
    expect(session.clientId).toBe('client-456');
    expect(session.socket).toBe(socket);
    expect(typeof session.presenceToken).toBe('string');
    expect(session.presenceToken.length).toBeGreaterThan(0);
  });

  it('attaches message, error, and close listeners on connect', () => {
    const { socket, mocks } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(mocks.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('returns the correct session from getSession', () => {
    const { socket } = createSocketFake();
    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    const session = service.getSession(requireClientId('client-456'));

    expect(session?.userId).toBe('user-123');
    expect(session?.clientId).toBe('client-456');
  });

  it('returns undefined from getSession for an unknown client', () => {
    expect(service.getSession(requireClientId('nope'))).toBeUndefined();
  });

  it('counts active sessions with getSessionCount', () => {
    const first = createSocketFake();
    const second = createSocketFake();

    expect(service.getSessionCount()).toBe(0);
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    expect(service.getSessionCount()).toBe(1);
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-2'),
      clientId: parseClientId('client-2'),
    });
    expect(service.getSessionCount()).toBe(2);
  });

  it('sends a message through the correct WebSocket', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-2'),
      clientId: parseClientId('client-2'),
    });

    const ok = service.sendToClient(requireClientId('client-1'), {
      type: 'MESSAGE',
      data: 'hello',
    });

    expect(ok).toBe(true);
    expect(first.mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'MESSAGE', data: 'hello' }),
    );
    expect(second.mocks.send).not.toHaveBeenCalled();
  });

  it('returns false for an unknown client', () => {
    expect(
      service.sendToClient(requireClientId('ghost'), { type: 'MESSAGE' }),
    ).toBe(false);
  });

  it('returns false when the socket is not open', () => {
    const { socket, mocks } = createSocketFake();
    socket.readyState = WebSocket.CLOSED;
    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(
      service.sendToClient(requireClientId('client-456'), { type: 'PING' }),
    ).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('removes the session when the socket closes', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    fireClose(fake);

    expect(service.getSession(requireClientId('client-456'))).toBeUndefined();
    expect(service.getSessionCount()).toBe(0);
  });

  it('leaves other sessions untouched when one socket closes', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-2'),
      clientId: parseClientId('client-2'),
    });

    fireClose(first);

    expect(service.getSessionCount()).toBe(1);
    expect(service.getSession(requireClientId('client-2'))?.socket).toBe(
      second.socket,
    );
  });

  it('closes the new socket and keeps the old session on duplicate clientId', () => {
    const oldClient = createSocketFake();
    const newClient = createSocketFake();
    service.handleConnection({
      socket: oldClient.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    const result = service.handleConnection({
      socket: newClient.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(result).toEqual({ kind: 'duplicate' });
    expect(newClient.mocks.close).toHaveBeenCalledWith(
      WS_CLOSE_POLICY_VIOLATION,
      'duplicate clientId',
    );
    expect(newClient.mocks.on).not.toHaveBeenCalled();
    expect(service.getSessionCount()).toBe(1);
    expect(service.getSession(requireClientId('client-456'))?.socket).toBe(
      oldClient.socket,
    );
    expect(
      service.sendToClient(requireClientId('client-456'), {
        type: 'MESSAGE',
        data: 'hi',
      }),
    ).toBe(true);
    expect(oldClient.mocks.send).toHaveBeenCalledTimes(1);
    expect(newClient.mocks.send).not.toHaveBeenCalled();
  });

  it('closes the socket with 1008 when userId/clientId are missing', () => {
    const { socket, mocks } = createSocketFake();

    const result = service.handleConnection({
      socket,
      userId: undefined,
      clientId: undefined,
    });

    expect(result).toEqual({ kind: 'rejected' });
    expect(mocks.close).toHaveBeenCalledWith(
      WS_CLOSE_POLICY_VIOLATION,
      'missing userId/clientId',
    );
    expect(service.getSessionCount()).toBe(0);
  });

  it('closes the socket with 1008 when ids are blank', () => {
    const { socket, mocks } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('   '),
      clientId: parseClientId('client-456'),
    });

    expect(mocks.close).toHaveBeenCalledWith(
      WS_CLOSE_POLICY_VIOLATION,
      'missing userId/clientId',
    );
    expect(service.getSessionCount()).toBe(0);
  });

  it('logs the string payload when a message is received', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    fireMessage(fake, 'hello-payload');

    expect(debugSpy).toHaveBeenCalledWith(
      'Message received from user-123 #client-456: hello-payload',
    );
  });

  it('logs a Buffer payload decoded as utf8 text', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    fireMessage(fake, Buffer.from('buffer-payload', 'utf8'));

    expect(debugSpy).toHaveBeenCalledWith(
      'Message received from user-123 #client-456: buffer-payload',
    );
  });

  it('truncates oversized payloads in the log', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    fireMessage(fake, 'x'.repeat(2000));

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('truncated 2000 chars'),
    );
    const logged = debugSpy.mock.calls[0]?.[0];
    expect(logged).toContain('Message received from user-123 #client-456: ');
    expect(typeof logged === 'string' ? logged.length : 0).toBeLessThan(2000);
  });

  it('warns with identity and close code on oversize transport errors', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    fireError(fake, createOversizeError());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Oversize frame rejected for user-123'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('#client-456'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('code 1009'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs non-oversize socket errors at error level', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    fireError(fake, new Error('boom'));

    expect(errorSpy).toHaveBeenCalledWith(
      'Socket error: boom',
      undefined,
      'client-456',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops unserializable payloads without sending', () => {
    const { socket, mocks } = createSocketFake();
    service.handleConnection({
      socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(service.sendToClient(requireClientId('client-1'), circular)).toBe(
      false,
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('fans out connect with the token and a user total of 1', () => {
    const { socket } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(tracker.handleConnect).toHaveBeenCalledTimes(1);
    expect(tracker.handleConnect).toHaveBeenCalledWith({
      userId: 'user-123',
      clientId: 'client-456',
      token: expect.any(String),
      userSessionCount: 1,
    });
    const event = tracker.handleConnect.mock.calls[0]?.[0];
    expect(typeof event?.token).toBe('string');
    expect((event?.token as string).length).toBeGreaterThan(0);
    expect(
      service.getSession(requireClientId('client-456'))?.presenceToken,
    ).toBe(event?.token);
  });

  it('mints a unique token per connection', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-789'),
    });

    const tokens = tracker.handleConnect.mock.calls.map(
      (call) => call[0].token,
    );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('reports the user total per connect and the remainder per disconnect', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-2'),
    });

    expect(tracker.handleConnect).toHaveBeenCalledTimes(2);
    expect(tracker.handleConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userSessionCount: 2 }),
    );

    fireClose(first);

    expect(tracker.handleDisconnect).toHaveBeenCalledTimes(1);
    expect(tracker.handleDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        clientId: 'client-1',
        userSessionCount: 1,
      }),
    );

    fireClose(second);

    expect(tracker.handleDisconnect).toHaveBeenCalledTimes(2);
    expect(tracker.handleDisconnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userSessionCount: 0 }),
    );
  });

  it('fans out disconnect with the session token', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    const token = tracker.handleConnect.mock.calls[0]?.[0].token;

    fireClose(fake);

    expect(tracker.handleDisconnect).toHaveBeenCalledTimes(1);
    expect(tracker.handleDisconnect).toHaveBeenCalledWith({
      userId: 'user-123',
      clientId: 'client-456',
      token,
      userSessionCount: 0,
    });
  });

  it('never notifies trackers on duplicate clientId', () => {
    const oldClient = createSocketFake();
    const newClient = createSocketFake();
    service.handleConnection({
      socket: oldClient.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    tracker.handleConnect.mockClear();

    service.handleConnection({
      socket: newClient.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(tracker.handleConnect).not.toHaveBeenCalled();
    expect(tracker.handleDisconnect).not.toHaveBeenCalled();
  });

  it('never notifies trackers on rejected connections', () => {
    const { socket } = createSocketFake();

    service.handleConnection({
      socket,
      userId: undefined,
      clientId: undefined,
    });

    expect(tracker.handleConnect).not.toHaveBeenCalled();
    expect(tracker.handleDisconnect).not.toHaveBeenCalled();
  });

  it('isolates a rejecting tracker so siblings still observe the connect', async () => {
    await module?.close();
    const failing = {
      handleConnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockRejectedValue(new Error('tracker down')),
      handleDisconnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    service = await compile([failing]);
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { socket } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(tracker.handleConnect).toHaveBeenCalledTimes(1);
    expect(tracker.handleConnect).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123', userSessionCount: 1 }),
    );
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Session tracker 0 connect failed'),
        );
      },
      { timeout: 3000 },
    );
  });

  it('isolates a synchronously throwing tracker into a logged rejection', async () => {
    await module?.close();
    const throwing = {
      handleConnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockImplementation(() => {
          throw new Error('sync boom');
        }),
      handleDisconnect: vi
        .fn<(event: SessionLifecycleEvent) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    service = await compile([throwing]);
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { socket } = createSocketFake();

    service.handleConnection({
      socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });

    expect(tracker.handleConnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Session tracker 0 connect failed'),
        );
      },
      { timeout: 3000 },
    );
  });

  it('skips serialization when no session exists', () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      expect(
        service.sendToClient(requireClientId('ghost'), { type: 'MESSAGE' }),
      ).toBe(false);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('publishes a user broadcast to user:{userId}', async () => {
    await service.sendToUser(requireUserId('user-123'), { type: 'PING' });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(
      'user:user-123',
      JSON.stringify({
        payload: { type: 'PING' },
      }),
    );
  });

  it('carries the excluded origin client in the broadcast envelope', async () => {
    await service.sendToUser(
      requireUserId('user-123'),
      { type: 'PING' },
      requireClientId('client-1'),
    );

    expect(publisher.publish).toHaveBeenCalledWith(
      'user:user-123',
      JSON.stringify({
        payload: { type: 'PING' },
        excludeClientId: 'client-1',
      }),
    );
  });

  it('warns and rejects when the broadcast publish fails', async () => {
    publisher.publish.mockRejectedValueOnce(new Error('READONLY'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.sendToUser(requireUserId('user-123'), { type: 'PING' }),
    ).rejects.toThrow('READONLY');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to broadcast to user:user-123'),
    );
  });

  it('rejects unserializable broadcast payloads without publishing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.sendToUser(requireUserId('user-123'), circular),
    ).rejects.toThrow('not serializable');
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropping unserializable broadcast'),
      expect.anything(),
    );
  });

  it('delivers a local broadcast to every session of the user', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    const other = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-2'),
    });
    service.handleConnection({
      socket: other.socket,
      userId: parseUserId('user-2'),
      clientId: parseClientId('client-3'),
    });

    const delivered = service.sendToLocalUser(requireUserId('user-1'), {
      type: 'PING',
    });

    expect(delivered).toBe(2);
    expect(first.mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'PING' }),
    );
    expect(second.mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'PING' }),
    );
    expect(other.mocks.send).not.toHaveBeenCalled();
  });

  it('skips the excluded origin client on local delivery', () => {
    const first = createSocketFake();
    const second = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: second.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-2'),
    });

    const delivered = service.sendToLocalUser(
      requireUserId('user-1'),
      { type: 'PING' },
      requireClientId('client-1'),
    );

    expect(delivered).toBe(1);
    expect(first.mocks.send).not.toHaveBeenCalled();
    expect(second.mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'PING' }),
    );
  });

  it('delivers to nobody when the user holds no local sessions', () => {
    expect(
      service.sendToLocalUser(requireUserId('ghost'), { type: 'PING' }),
    ).toBe(0);
  });

  it('routes a sendMessage frame via sendToUser excluding the origin', async () => {
    const fake = connectSender();

    fireMessage(
      fake,
      JSON.stringify({
        op: SEND_MESSAGE_OP,
        target: 'user-2',
        message: { text: 'hi' },
      }),
    );

    await vi.waitFor(() => {
      expect(publisher.publish).toHaveBeenCalledTimes(1);
    });
    expect(publisher.publish).toHaveBeenCalledWith(
      'user:user-2',
      JSON.stringify({
        payload: { text: 'hi' },
        excludeClientId: 'client-1',
      }),
    );
    expect(fake.mocks.send).not.toHaveBeenCalled();
    expect(fake.mocks.close).not.toHaveBeenCalled();
  });

  it('ignores noise without publishing, NACKing, or closing', () => {
    const fake = connectSender();

    fireMessage(fake, 'hello-payload');
    fireMessage(fake, JSON.stringify({ op: 'other', target: 'user-2' }));

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(fake.mocks.send).not.toHaveBeenCalled();
    expect(fake.mocks.close).not.toHaveBeenCalled();
    expect(service.getSessionCount()).toBe(1);
  });

  it('NACKs an invalid target without publishing', () => {
    const fake = connectSender();
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    fireMessage(
      fake,
      JSON.stringify({
        op: SEND_MESSAGE_OP,
        target: '   ',
        message: 'PING',
      }),
    );

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid target'),
    );
    expect(fake.mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ op: SEND_MESSAGE_ERROR_OP, reason: 'invalid target' }),
    );
    expect(fake.mocks.close).not.toHaveBeenCalled();
    expect(service.getSessionCount()).toBe(1);
  });

  it('NACKs and keeps the socket when delivery rejects', async () => {
    const fake = connectSender();
    publisher.publish.mockRejectedValueOnce(new Error('READONLY'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    fireMessage(
      fake,
      JSON.stringify({
        op: SEND_MESSAGE_OP,
        target: 'user-2',
        message: 'PING',
      }),
    );

    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to deliver message'),
        );
      },
      { timeout: 3000 },
    );
    await vi.waitFor(() => {
      expect(fake.mocks.send).toHaveBeenCalledWith(
        JSON.stringify({
          op: SEND_MESSAGE_ERROR_OP,
          reason: 'delivery failed',
        }),
      );
    });
    expect(fake.mocks.close).not.toHaveBeenCalled();
    expect(service.getSessionCount()).toBe(1);
  });
});
