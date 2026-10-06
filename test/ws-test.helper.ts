/**
 * Test-only WS identity parsers and socket fakes (no casts in specs).
 *
 * - single owner of the fail-fast branded-id helpers for WS suites
 * - single owner of the fake socket shape: literals in specs are always
 *   valid, so a bad one fails the test loudly
 * - `send` both records into `sent` and stays a mock, so unit suites assert
 *   calls while fan-out suites read delivered payloads off the same fake.
 */
import { vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  parseClientId,
  parseUserId,
  type ClientId,
  type SessionSocket,
  type UserId,
} from '../src/ws/session.interface';

/**
 * Parses a test `userId`, failing fast on bad literals.
 *
 * @param value Literal user id used by the test.
 * @return The branded user id.
 */
export function requireUserId(value: string): UserId {
  const parsed = parseUserId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test userId: ${value}`);
  }
  return parsed;
}

/**
 * Parses a test `clientId`, failing fast on bad literals.
 *
 * @param value Literal client id used by the test.
 * @return The branded client id.
 */
export function requireClientId(value: string): ClientId {
  const parsed = parseClientId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test clientId: ${value}`);
  }
  return parsed;
}

/**
 * Creates a fake socket satisfying the registry's structural socket type.
 *
 * - `satisfies` validates the shape without widening or casting
 * - defaults `readyState` to OPEN so sends succeed
 * - stubs `on`/`send`/`close` with vitest mocks, and `send` also captures
 *   into `sent` for suites that read deliveries instead of asserting calls.
 *
 * @return Fake socket plus its mocks and captured payloads.
 */
export function createSocketFake() {
  const sent: string[] = [];
  const on =
    vi.fn<
      (
        event: 'message' | 'error' | 'close',
        listener: (data: unknown) => void,
      ) => void
    >();
  const send = vi.fn<(payload: string) => void>((payload: string): void => {
    sent.push(payload);
  });
  const close = vi.fn<(code?: number, reason?: string) => void>();
  const readyState: number = WebSocket.OPEN;
  const socket = {
    readyState,
    on,
    send,
    close,
  } satisfies SessionSocket;
  return { socket, mocks: { on, send, close }, sent };
}

/**
 * Socket stub type shared by unit and e2e suites.
 */
export type SocketFake = ReturnType<typeof createSocketFake>;

/**
 * Finds the listener the registry attached for one socket event.
 *
 * - fails fast when registration attached no listener for the event.
 *
 * @param fake Fake created by `createSocketFake`.
 * @param event Socket event whose listener to fire.
 * @return The captured listener.
 */
function socketListener(
  fake: SocketFake,
  event: 'message' | 'error' | 'close',
): (data: unknown) => void {
  const call = fake.mocks.on.mock.calls.find((args) => args[0] === event);
  if (call === undefined) {
    throw new Error(`Expected a ${event} listener`);
  }
  return call[1];
}

/**
 * Fires the captured `close` listener of a fake socket.
 *
 * - simulates the driver emitting `close` after the socket disconnects.
 *
 * @param fake Fake created by `createSocketFake`.
 */
export function fireClose(fake: SocketFake): void {
  socketListener(fake, 'close')(undefined);
}

/**
 * Fires the captured `message` listener of a fake socket.
 *
 * - simulates the driver emitting `message` with the given payload.
 *
 * @param fake Fake created by `createSocketFake`.
 * @param payload Payload to pass to the message listener.
 */
export function fireMessage(fake: SocketFake, payload: unknown): void {
  socketListener(fake, 'message')(payload);
}

/**
 * Fires the captured `error` listener of a fake socket.
 *
 * - simulates the driver emitting `error` with the given value.
 *
 * @param fake Fake created by `createSocketFake`.
 * @param err Error value to pass to the error listener.
 */
export function fireError(fake: SocketFake, err: unknown): void {
  socketListener(fake, 'error')(err);
}
