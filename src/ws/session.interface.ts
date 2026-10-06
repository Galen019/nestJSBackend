/**
 * WebSocket domain types and gateway identity helpers.
 */

/** User identity, validated once at the connection boundary. */
export type UserId = string & { readonly __brand: 'UserId' };

/** Client identity, the unique key of one WebSocket session. */
export type ClientId = string & { readonly __brand: 'ClientId' };

/**
 * Socket operations used by the session registry.
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
 * Identity and socket data for a connection.
 */
export interface ConnectionParams {
  socket: SessionSocket;
  userId: UserId | undefined;
  clientId: ClientId | undefined;
}

/**
 * Active WebSocket session, including its presence token.
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
 * Session lifecycle data shared with trackers.
 */
export interface SessionLifecycleEvent {
  userId: UserId;
  clientId: ClientId;
  token: string;
  userSessionCount: number;
}

/**
 * Handles session connect and disconnect events.
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
 * Returns a non-blank string value unchanged.
 *
 * @param value Raw upgrade query value.
 * @return The value, or undefined if blank or not a string.
 */
export function parseNonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

/**
 * Parses a raw user ID query value.
 *
 * @param value Raw upgrade query value.
 * @return A branded ID, or undefined if unusable.
 */
export function parseUserId(value: unknown): UserId | undefined {
  const parsed = parseNonBlank(value);
  return parsed === undefined ? undefined : (parsed as UserId);
}

/**
 * Parses a raw client ID query value.
 *
 * @param value Raw upgrade query value.
 * @return A branded ID, or undefined if unusable.
 */
export function parseClientId(value: unknown): ClientId | undefined {
  const parsed = parseNonBlank(value);
  return parsed === undefined ? undefined : (parsed as ClientId);
}

/**
 * Parses a non-blank raw token value; verification happens later.
 *
 * @param value Raw upgrade query value.
 * @return The token, or undefined if unusable.
 */
export function parseToken(value: unknown): string | undefined {
  return parseNonBlank(value);
}

/**
 * Identity parsed from a WebSocket upgrade URL.
 */
export interface GatewayIdentity {
  userId: UserId | undefined;
  clientId: ClientId | undefined;
  token: string | undefined;
}

/**
 * Gateway authorization result.
 */
export type ResolveIdentityResult =
  | { kind: 'authorized'; userId: UserId; clientId: ClientId }
  | { kind: 'rejected'; reason: string };

/**
 * Parses identity fields from WebSocket upgrade arguments.
 *
 * @param args Raw arguments from the WebSocket adapter.
 * @return Parsed IDs and raw token, or undefined fields if unavailable.
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
 * Verifies the token and checks its subject matches the requested user.
 *
 * @param identity Parsed upgrade identity.
 * @param verify Token verifier that throws when invalid.
 * @return Authorization result for the gateway.
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
 * Checks whether a value has a valid optional URL field.
 *
 * @param value Candidate upgrade request.
 * @return Whether its URL is a string or undefined.
 */
function hasUpgradeUrl(value: unknown): value is { url?: string } {
  if (typeof value !== 'object' || value === null || !('url' in value)) {
    return false;
  }
  const url = value.url;
  return url === undefined || typeof url === 'string';
}
