/**
 * Unit suite for WsService with structurally-typed socket fakes.
 *
 * - connect: session added with userId/clientId/socket/presenceToken
 * - trackers: registered fans out connect with the token and user total, never on duplicate/rejected
 * - lookup: getSession returns the entry, getSessionCount tracks active sessions
 * - send: routes JSON through the right socket, false for unknown/closed clients
 * - close: the registration close listener removes the session and fans out disconnect by token
 * - duplicate: new socket closed with 1008, existing session kept
 * - message: inbound payload is logged at debug with userId/clientId attribution
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { requireClientId } from '../../test/ws-test.helper';
import {
  parseClientId,
  parseUserId,
  SESSION_TRACKERS,
  type SessionLifecycleEvent,
  type SessionSocket,
} from './session.interface';
import { WS_CLOSE_POLICY_VIOLATION, WsService } from './ws.service';

/**
 * Creates a fake socket satisfying the registry's structural socket type.
 *
 * - `satisfies` validates the shape without widening or casting
 * - defaults `readyState` to OPEN so sends succeed
 * - stubs `on`/`send`/`close` with vitest mocks.
 *
 * @return Fake socket plus its mocks.
 */
function createSocketFake() {
  const on =
    vi.fn<
      (
        event: 'message' | 'error' | 'close',
        listener: (data: unknown) => void,
      ) => void
    >();
  const send = vi.fn<(payload: string) => void>();
  const close = vi.fn<(code?: number, reason?: string) => void>();
  const initialState: number = WebSocket.OPEN;
  const socket = {
    readyState: initialState,
    on,
    send,
    close,
  } satisfies SessionSocket;
  return { socket, mocks: { on, send, close } };
}

/**
 * Fires the captured `close` listener of a fake socket.
 *
 * - simulates the driver emitting `close` after the socket disconnects
 * - fails fast when registration attached no close listener.
 *
 * @param fake Fake created by `createSocketFake`.
 */
function fireClose(fake: ReturnType<typeof createSocketFake>): void {
  const closeCall = fake.mocks.on.mock.calls.find(
    (call) => call[0] === 'close',
  );
  if (closeCall === undefined) {
    throw new Error('Expected a close listener');
  }
  closeCall[1](undefined);
}

/**
 * Fires the captured `message` listener of a fake socket.
 *
 * - simulates the driver emitting `message` with the given payload
 * - fails fast when registration attached no message listener.
 *
 * @param fake Fake created by `createSocketFake`.
 * @param payload Payload to pass to the message listener.
 * @return Nothing, the listener is invoked synchronously.
 */
function fireMessage(
  fake: ReturnType<typeof createSocketFake>,
  payload: unknown,
): void {
  const messageCall = fake.mocks.on.mock.calls.find(
    (call) => call[0] === 'message',
  );
  if (messageCall === undefined) {
    throw new Error('Expected a message listener');
  }
  messageCall[1](payload);
}

describe('WsService', () => {
  let service: WsService;
  let module: TestingModule | undefined;
  let tracker: {
    handleConnect: ReturnType<
      typeof vi.fn<(event: SessionLifecycleEvent) => void>
    >;
    handleDisconnect: ReturnType<
      typeof vi.fn<(event: SessionLifecycleEvent) => void>
    >;
  };

  /**
   * Builds a testing module with a fresh WsService.
   *
   * - provides a mocked tracker list so no presence or Redis calls happen
   * - tracks the module so it can be closed after each test.
   */
  async function compile(): Promise<WsService> {
    tracker = {
      handleConnect: vi.fn<(event: SessionLifecycleEvent) => void>(),
      handleDisconnect: vi.fn<(event: SessionLifecycleEvent) => void>(),
    };
    module = await Test.createTestingModule({
      providers: [
        WsService,
        { provide: SESSION_TRACKERS, useValue: [tracker] },
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
});
