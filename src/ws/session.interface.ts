/**
 * WebSocket domain types.
 *
 * - Branded `UserId`/`ClientId` validated once at the boundary
 * - Minimal `SessionSocket` surface the registry needs
 * - `Session` shape stored in the registry keyed by `clientId`
 * - `SessionTracker` observers fanned out on connect/disconnect, so new
 *   side effects wire in via `SESSION_TRACKERS` without touching the registry
 * - Gateway identity parsing plus the authorize/reject decision live here as
 *   pure functions, so the gateway stays a thin close-and-delegate adapter.
 */

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
 * - `presenceToken` is a per-connection unique token mirrored into the
 *   `Clients` presence row, so a stale socket-close delete cannot remove a
 *   fresh row written by a later reconnect on the same `clientId`.
 */
export interface Session {
  userId: UserId;
  clientId: ClientId;
  socket: SessionSocket;
  presenceToken: string;
}

/** DI token for the ordered session-tracker fan-out list. */
export const SESSION_TRACKERS = 'SESSION_TRACKERS';

/**
 * Lifecycle event fanned out to every session tracker.
 *
 * - `token` is the per-connection token minted at registration
 * - `userSessionCount` is the local session total for `userId` after the
 *   event: connect includes the new session (first reports 1), disconnect
 *   excludes the closed one (last reports 0).
 */
export interface SessionLifecycleEvent {
  userId: UserId;
  clientId: ClientId;
  token: string;
  userSessionCount: number;
}

/**
 * Observer of WebSocket session lifecycle.
 *
 * - `WsService` owns the sessions and notifies every tracker on
 *   connect/disconnect, so tracker N+1 is a module-wiring line
 * - handlers are async and may reject: `WsService` settles every tracker
 *   with `Promise.allSettled` and logs failures, so one slow or throwing
 *   tracker cannot stall registration, teardown, or sibling trackers.
 */
export interface SessionTracker {
  /**
   * Observes a newly registered session.
   *
   * @param event Session identity plus the post-connect user total.
   * @return Resolves when the tracker has observed the connect.
   */
  handleConnect(event: SessionLifecycleEvent): Promise<void>;
  /**
   * Observes a closed session.
   *
   * @param event Session identity plus the remaining user total.
   * @return Resolves when the tracker has observed the disconnect.
   */
  handleDisconnect(event: SessionLifecycleEvent): Promise<void>;
}

/**
 * Parses a raw identity query value into a usable string.
 *
 * - single owner of the non-blank check behind every id/token parser
 * - rejects missing, non-string, empty, and whitespace-only values
 * - returns the original string unchanged when it carries content.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The string, or undefined when the value is unusable.
 */
export function parseNonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

/**
 * Parses a raw `userId` query value into the domain type.
 *
 * - boundary parser delegating to `parseNonBlank`, brand cast earned by it.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The branded id, or undefined when the value is unusable.
 */
export function parseUserId(value: unknown): UserId | undefined {
  const parsed = parseNonBlank(value);
  return parsed === undefined ? undefined : (parsed as UserId);
}

/**
 * Parses a raw `clientId` query value into the domain type.
 *
 * - boundary parser delegating to `parseNonBlank`, brand cast earned by it.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The branded id, or undefined when the value is unusable.
 */
export function parseClientId(value: unknown): ClientId | undefined {
  const parsed = parseNonBlank(value);
  return parsed === undefined ? undefined : (parsed as ClientId);
}

/**
 * Parses the raw `token` query value.
 *
 * - boundary parser delegating to `parseNonBlank`, presence check only
 * - the token itself is verified later, this only checks presence.
 *
 * @param value Raw query value from the upgrade URL.
 * @return The token string, or undefined when unusable.
 */
export function parseToken(value: unknown): string | undefined {
  return parseNonBlank(value);
}

/**
 * Identity parsed from the WS upgrade URL.
 *
 * - token stays raw; verification happens in `resolveGatewayIdentity`
 * - kept separate from `ConnectionParams` so raw tokens never reach the registry.
 */
export interface GatewayIdentity {
  userId: UserId | undefined;
  clientId: ClientId | undefined;
  token: string | undefined;
}

/**
 * Outcome of resolving one upgrade request to an authorize/reject decision.
 *
 * - discriminated union so the gateway has a single close site: `rejected`
 *   closes with 1008, `authorized` delegates to the registry.
 */
export type ResolveIdentityResult =
  | { kind: 'authorized'; userId: UserId; clientId: ClientId }
  | { kind: 'rejected'; reason: string };

/**
 * Extracts `userId`/`clientId`/`token` from the upgrade request.
 *
 * - boundary parse: raw query values become branded ids or undefined
 * - token stays a raw string; verification happens in `resolveGatewayIdentity`
 * - returns undefined values when no URL is present, caller then rejects.
 *
 * @param args Raw connection args from the ws adapter.
 * @return The parsed identity values plus the raw token.
 */
export function extractGatewayIdentity(args: unknown[]): GatewayIdentity {
  const request = args[0];
  if (!hasUpgradeUrl(request) || request.url === undefined) {
    return { userId: undefined, clientId: undefined, token: undefined };
  }
  try {
    const params = new URL(request.url, 'http://localhost').searchParams;
    return {
      userId: parseUserId(params.get('userId')),
      clientId: parseClientId(params.get('clientId')),
      token: parseToken(params.get('token')),
    };
  } catch {
    return { userId: undefined, clientId: undefined, token: undefined };
  }
}

/**
 * Resolves one parsed identity to an authorize/reject decision.
 *
 * - rejects when the token is missing or fails verification
 * - rejects when the token carries no `sub`: anonymous tokens cannot claim
 *   any `userId`, the binding is fail-closed
 * - rejects when `sub` differs from `userId` or when ids are missing
 * - pure function of identity plus verifier, unit-testable without sockets.
 *
 * @param identity Parsed upgrade identity with the raw token.
 * @param verify Token verifier returning the payload, throwing when invalid.
 * @return The authorize/reject decision for the gateway to act on.
 */
export function resolveGatewayIdentity(
  identity: GatewayIdentity,
  verify: (token: string) => { sub?: string },
): ResolveIdentityResult {
  const { userId, clientId, token } = identity;
  if (token === undefined) {
    return { kind: 'rejected', reason: 'missing token' };
  }
  let sub: string | undefined;
  try {
    sub = verify(token).sub;
  } catch {
    return { kind: 'rejected', reason: 'invalid token' };
  }
  if (sub === undefined) {
    return { kind: 'rejected', reason: 'missing token subject' };
  }
  if (userId === undefined || clientId === undefined) {
    return { kind: 'rejected', reason: 'missing userId/clientId' };
  }
  if (sub !== userId) {
    return { kind: 'rejected', reason: 'token subject mismatch' };
  }
  return { kind: 'authorized', userId, clientId };
}

/**
 * Checks that a value carries an upgrade URL.
 *
 * - verifies the full claimed shape: object with a string-or-undefined `url`
 * - narrows `unknown` adapter args without casts.
 *
 * @param value Candidate upgrade request value.
 * @return True when the value has a usable URL field.
 */
function hasUpgradeUrl(value: unknown): value is { url?: string } {
  if (typeof value !== 'object' || value === null || !('url' in value)) {
    return false;
  }
  const url = value.url;
  return url === undefined || typeof url === 'string';
}
