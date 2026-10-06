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

/** Client-to-server op that routes one message to another user's sessions. */
export const SEND_MESSAGE_OP = 'sendMessage' as const;

/** Server-to-client op that reports a rejected inbound frame. */
export const SEND_MESSAGE_ERROR_OP = 'error' as const;

/**
 * Wire shape of a client `sendMessage` frame.
 */
export interface SendMessageFrame {
  op: typeof SEND_MESSAGE_OP;
  target: string;
  message: unknown;
}

/**
 * Wire shape of a server rejection for an inbound frame.
 */
export interface SendMessageErrorFrame {
  op: typeof SEND_MESSAGE_ERROR_OP;
  reason: string;
}

/**
 * Outcome of parsing one inbound socket frame.
 *
 * - `send` carries a validated target plus the verbatim payload
 * - `ignore` drops noise with a debug log and no client feedback
 * - `invalid` drops a client error with a warn log plus a NACK.
 */
export type InboundFrame =
  | { kind: 'send'; target: UserId; message: unknown }
  | { kind: 'ignore'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * Parses one raw socket payload into its routing decision.
 *
 * - non-JSON, non-object, unknown op, and missing message are `ignore`
 * - blank target is `invalid` so the caller warns and NACKs
 * - mirrors `parseUserTopicEnvelope` as a value, never a throw.
 *
 * @param raw Raw message payload from the socket.
 * @return The routing decision for the caller to switch on.
 */
export function parseInboundFrame(raw: unknown): InboundFrame {
  const text = typeof raw === 'string' ? raw : String(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'ignore', reason: 'non-JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'ignore', reason: 'non-object' };
  }
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  if (record.op !== SEND_MESSAGE_OP) {
    return { kind: 'ignore', reason: 'unknown op' };
  }
  const target = parseUserId(record.target);
  if (target === undefined) {
    return { kind: 'invalid', reason: 'invalid target' };
  }
  if (!('message' in record) || record.message === undefined) {
    return { kind: 'ignore', reason: 'missing message' };
  }
  return { kind: 'send', target, message: record.message };
}

/**
 * Decides whether one user may send to another.
 *
 * - open DM is intentional for v1: any authenticated client may message any
 *   user, and the registry stays the single enforcement point
 * - keep future ACL, block-list, or rate-limit checks here so no new branch
 *   spreads into the registry when the policy tightens.
 *
 * @param sender Owner of the sending session.
 * @param target Owner of the recipient sessions.
 * @return True when the send may proceed.
 */
export function canSendTo(sender: UserId, target: UserId): boolean {
  void sender;
  void target;
  return true;
}

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
