/**
 * WebSocket domain types.
 *
 * - Branded `UserId`/`ClientId` validated once at the boundary
 * - Minimal `SessionSocket` surface the registry needs
 * - `Session` shape stored in the registry keyed by `clientId`
 */

import type { WebSocket } from 'ws';

/** User identity, validated once at the connection boundary. */
export type UserId = string & { readonly __brand: 'UserId' };

/** Client identity, the unique key of one WebSocket session. */
export type ClientId = string & { readonly __brand: 'ClientId' };

/**
 * Minimal socket surface the session registry needs.
 *
 * - Real `ws` sockets satisfy this structurally, fakes do too without casts
 * - Keeps the registry decoupled from the full driver class.
 */
export interface SessionSocket {
  readonly readyState: number;
  on(
    event: 'message' | 'error' | 'close',
    listener: (data: unknown) => void,
  ): unknown;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Compile-time contract with the `ws` driver.
 *
 * - A real driver socket must satisfy `SessionSocket` with no cast
 * - A driver upgrade that breaks the shape fails the build, not production.
 */
type DriverSocketCheck = WebSocket extends SessionSocket ? true : false;
const driverSocketCheck: DriverSocketCheck = true;
void driverSocketCheck;

/**
 * Parameters for registering one connection.
 *
 * - Object args so `userId`/`clientId` order is self-documenting
 * - Ids stay `undefined` when the upgrade URL carries none, service rejects those.
 */
export interface ConnectionParams {
  socket: SessionSocket;
  userId: UserId | undefined;
  clientId: ClientId | undefined;
}

/**
 * Live WebSocket session for one connected client.
 *
 * - `socket` is the per-connection WebSocket instance
 * - `sequenceNumber` starts at 0 and is stored for future use
 * - `heartbeatAt` is the connect-time timestamp, stored for future use.
 */
export interface Session {
  userId: UserId;
  clientId: ClientId;
  socket: SessionSocket;
  sequenceNumber: number;
  heartbeatAt: number;
}

/**
 * Parses a raw `userId` query value into the domain type.
 *
 * - boundary parser, rejects missing, non-string, empty, and blank values
 * - the brand cast is earned by the check above it.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The branded id, or undefined when the value is unusable.
 */
export function parseUserId(value: unknown): UserId | undefined {
  if (!isNonBlankString(value)) {
    return undefined;
  }
  return value as UserId;
}

/**
 * Parses a raw `clientId` query value into the domain type.
 *
 * - boundary parser, rejects missing, non-string, empty, and blank values
 * - the brand cast is earned by the check above it.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The branded id, or undefined when the value is unusable.
 */
export function parseClientId(value: unknown): ClientId | undefined {
  if (!isNonBlankString(value)) {
    return undefined;
  }
  return value as ClientId;
}

/**
 * Checks that a value is a non-blank string.
 *
 * - shared narrowing behind the id parsers, rejects whitespace-only strings.
 *
 * @param value Candidate identity value.
 * @return True when the value is a usable non-blank string.
 */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
