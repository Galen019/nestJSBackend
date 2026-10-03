/**
 * Unit suite for WsService with structurally-typed socket fakes.
 *
 * - connect: session added with userId/clientId/socket/sequenceNumber/heartbeatAt
 * - lookup: getSession returns the entry, getSessionCount tracks active sessions
 * - send: routes JSON through the right socket, false for unknown/closed clients
 * - close: the registration close listener removes the session
 * - duplicate: new socket closed with 1008, existing session kept
 * - message: inbound payload is forwarded to the debug log without side effects
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  parseClientId,
  parseUserId,
  type ClientId,
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

/**
 * Fires the captured `error` listener of a fake socket.
 *
 * - simulates the driver emitting `error` with the given value
 * - fails fast when registration attached no error listener.
 *
 * @param fake Fake created by `createSocketFake`.
 * @param err Error value to pass to the error listener.
 * @return Nothing, the listener is invoked synchronously.
 */
function fireError(
  fake: ReturnType<typeof createSocketFake>,
  err: unknown,
): void {
  const errorCall = fake.mocks.on.mock.calls.find(
    (call) => call[0] === 'error',
  );
  if (errorCall === undefined) {
    throw new Error('Expected an error listener');
  }
  errorCall[1](err);
}

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

describe('WsService', () => {
  let service: WsService;
  let module: TestingModule | undefined;

  /**
   * Builds a testing module with a fresh WsService.
   *
   * - no external providers needed, the registry is in-memory
   * - tracks the module so it can be closed after each test.
   */
  async function compile(): Promise<WsService> {
    module = await Test.createTestingModule({
      providers: [WsService],
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

  it('stores the correct userId, clientId, socket, sequenceNumber, and heartbeatAt', () => {
    const { socket } = createSocketFake();
    const before = Date.now();

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
    expect(session.sequenceNumber).toBe(0);
    expect(session.heartbeatAt).toBeGreaterThanOrEqual(before);
    expect(session.heartbeatAt).toBeLessThanOrEqual(Date.now());
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
      expect.stringContaining('hello-payload'),
      'client-456',
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
      expect.stringContaining('buffer-payload'),
      'client-456',
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
      'client-456',
    );
    const logged = debugSpy.mock.calls[0]?.[0];
    expect(typeof logged === 'string' ? logged.length : 0).toBeLessThan(2000);
  });

  it('fans out to many clients and counts sent vs skipped', () => {
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

    const result = service.sendToClients(
      [
        requireClientId('client-1'),
        requireClientId('client-2'),
        requireClientId('ghost'),
      ],
      { type: 'MESSAGE', data: 'hi' },
    );

    expect(result).toEqual({ sent: 2, skipped: 1 });
    expect(first.mocks.send).toHaveBeenCalledTimes(1);
    expect(second.mocks.send).toHaveBeenCalledTimes(1);
  });

  it('skips closed sockets when fanning out', () => {
    const openClient = createSocketFake();
    const closedFake = createSocketFake();
    closedFake.socket.readyState = WebSocket.CLOSED;
    service.handleConnection({
      socket: openClient.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });
    service.handleConnection({
      socket: closedFake.socket,
      userId: parseUserId('user-2'),
      clientId: parseClientId('client-2'),
    });

    const result = service.sendToClients(
      [requireClientId('client-1'), requireClientId('client-2')],
      { type: 'PING' },
    );

    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(openClient.mocks.send).toHaveBeenCalledTimes(1);
    expect(closedFake.mocks.send).not.toHaveBeenCalled();
  });
});

/**
 * Unit suite for WsService tracing spans.
 *
 * - uses an in-memory OTel provider so spans are captured without an exporter
 * - asserts connection/send span names, allowlisted attributes, and redaction
 * - asserts rejected/duplicate paths end error spans without registering sessions
 * - asserts transient socket errors record events without failing the span
 * - asserts sends still return counts when ending the span throws.
 */
describe('WsService tracing', () => {
  let service: WsService;
  let module: TestingModule | undefined;
  let provider: BasicTracerProvider | undefined;
  let exporter: InMemorySpanExporter;

  /**
   * Registers an in-memory tracer provider, then builds a fresh WsService.
   *
   * - provider first so the service tracer delegates to it
   * - fresh exporter per test so finished spans never leak across tests.
   *
   * @return The compiled service.
   */
  async function compileWithTracing(): Promise<WsService> {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    module = await Test.createTestingModule({
      providers: [WsService],
    }).compile();
    return module.get<WsService>(WsService);
  }

  beforeEach(async () => {
    service = await compileWithTracing();
  });

  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
    trace.disable();
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('ends the connection span when the socket closes', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    fireClose(fake);

    const connections = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'ws.connection');
    expect(connections).toHaveLength(1);
    expect(connections[0]?.attributes['user.id']).toBe('user-123');
    expect(connections[0]?.attributes['client.id']).toBe('client-456');
    const keys = Object.keys(connections[0]?.attributes ?? {});
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('authorization');
  });

  it('ends an error span for rejected connections', () => {
    const { socket } = createSocketFake();

    const result = service.handleConnection({
      socket,
      userId: undefined,
      clientId: undefined,
    });

    expect(result).toEqual({ kind: 'rejected' });
    const connections = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'ws.connection');
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(connections[0]?.attributes['ws.close.code']).toBe(
      WS_CLOSE_POLICY_VIOLATION,
    );
    expect(service.getSessionCount()).toBe(0);
  });

  it('ends an error span for duplicates and keeps the old session', () => {
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
    const errors = exporter
      .getFinishedSpans()
      .filter((span) => span.status.code === SpanStatusCode.ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.attributes['ws.close.reason']).toBe('duplicate clientId');
    expect(service.getSessionCount()).toBe(1);
  });

  it('records a fan-out span with counts and byte size, never the body', () => {
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

    service.sendToClients(
      [requireClientId('client-1'), requireClientId('ghost')],
      { type: 'MESSAGE', data: 'hi' },
    );

    const sends = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'ws.send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.attributes['client.ids.count']).toBe(2);
    expect(sends[0]?.attributes['sent.count']).toBe(1);
    expect(sends[0]?.attributes['skipped.count']).toBe(1);
    expect(typeof sends[0]?.attributes['message.bytes']).toBe('number');
    const serialized = JSON.stringify(sends[0]?.attributes ?? {});
    expect(serialized).not.toContain('hi');
  });

  it('records inbound messages as span events, not spans', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    fireMessage(fake, 'hello-payload');
    fireClose(fake);

    const spans = exporter.getFinishedSpans();
    expect(spans.some((span) => span.name === 'ws.message')).toBe(false);
    const connection = spans.find((span) => span.name === 'ws.connection');
    expect(
      connection?.events.some((event) => event.name === 'ws.message.received'),
    ).toBe(true);
  });

  it('records transient socket errors as events without failing the span', () => {
    const fake = createSocketFake();
    service.handleConnection({
      socket: fake.socket,
      userId: parseUserId('user-123'),
      clientId: parseClientId('client-456'),
    });
    fireError(fake, new Error('socket boom'));

    expect(service.getSessionCount()).toBe(1);
    fireClose(fake);

    const connections = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'ws.connection');
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(
      connections[0]?.events.some((event) => event.name === 'exception'),
    ).toBe(true);
  });

  it('still returns send counts when ending the span throws', async () => {
    await provider?.shutdown();
    provider = undefined;
    trace.disable();
    await module?.close();
    module = undefined;
    provider = new BasicTracerProvider({
      spanProcessors: [
        {
          onStart: (): void => undefined,
          onEnd: (): void => {
            throw new Error('export boom');
          },
          forceFlush: (): Promise<void> => Promise.resolve(),
          shutdown: (): Promise<void> => Promise.resolve(),
        },
      ],
    });
    trace.setGlobalTracerProvider(provider);
    module = await Test.createTestingModule({
      providers: [WsService],
    }).compile();
    service = module.get<WsService>(WsService);

    const first = createSocketFake();
    service.handleConnection({
      socket: first.socket,
      userId: parseUserId('user-1'),
      clientId: parseClientId('client-1'),
    });

    const result = service.sendToClients(
      [requireClientId('client-1'), requireClientId('ghost')],
      { type: 'MESSAGE' },
    );

    expect(result).toEqual({ sent: 1, skipped: 1 });
  });
});
