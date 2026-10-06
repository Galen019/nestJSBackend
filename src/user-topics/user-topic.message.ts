/**
 * Redis user-topic envelope contract for distributed WS fan-out.
 *
 * - single owner of the `{ payload, excludeClientId? }` shape published to
 *   `user:{userId}` and parsed back on delivery
 * - `excludeClientId` carries the origin client so a broadcast never echoes
 *   back to its sender; server-initiated sends omit it and reach every
 *   session of the user
 * - single owner of the channel naming in both directions: `channelFor`
 *   builds `user:{userId}`, `userIdFromChannel` strips it back, so the
 *   channel stays the authority for the target user and receivers never
 *   trust a user field in the body
 * - parse failures are values, never throws, so the subscriber drops junk
 *   with a warn instead of stalling sibling deliveries.
 */

import {
  parseClientId,
  parseUserId,
  type ClientId,
  type UserId,
} from '../ws/session.interface';

/** Prefix for per-user channels; `channelFor` adds it, receivers strip it. */
const USER_CHANNEL_PREFIX = 'user:';

/**
 * Envelope published to one user's channel.
 *
 * - `payload` is delivered verbatim to every local session of the user
 * - `excludeClientId` skips the origin client when present.
 */
export interface UserTopicEnvelope {
  payload: unknown;
  excludeClientId?: ClientId;
}

/**
 * Outcome of parsing one raw channel payload.
 *
 * - discriminated union so receivers handle the drop path explicitly.
 */
export type ParseEnvelopeResult =
  | { kind: 'ok'; payload: unknown; excludeClientId: ClientId | undefined }
  | { kind: 'invalid'; reason: string };

/**
 * Builds the channel name for one user.
 *
 * @param userId Owner of the connections.
 * @return The Redis pub/sub channel for the user.
 */
export function channelFor(userId: UserId): string {
  return `${USER_CHANNEL_PREFIX}${userId}`;
}

/**
 * Serializes one broadcast payload into its channel envelope.
 *
 * - throws when `payload` cannot be serialized, so `sendToUser` observes the
 *   failure instead of publishing a truncated message.
 *
 * @param payload Payload to deliver to every session of the user.
 * @param excludeClientId Origin client to skip on delivery, if any.
 * @return The serialized envelope for `publish`.
 */
export function buildUserTopicEnvelope(
  payload: unknown,
  excludeClientId?: ClientId,
): string {
  const envelope: UserTopicEnvelope = {
    payload,
  };
  if (excludeClientId !== undefined) {
    envelope.excludeClientId = excludeClientId;
  }
  return JSON.stringify(envelope);
}

/**
 * Parses one raw channel payload into its delivery parts.
 *
 * - drops non-objects, missing payloads, and malformed `excludeClientId`
 *   with a reason, never with a throw.
 *
 * @param raw Raw channel payload from the subscriber.
 * @return The payload plus the client to skip, or the drop reason.
 */
export function parseUserTopicEnvelope(raw: string): ParseEnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'malformed JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid', reason: 'envelope is not an object' };
  }
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  if (!('payload' in record)) {
    return { kind: 'invalid', reason: 'missing payload' };
  }
  const excludeClientId =
    typeof record.excludeClientId === 'string'
      ? parseClientId(record.excludeClientId)
      : undefined;
  if (record.excludeClientId !== undefined && excludeClientId === undefined) {
    return { kind: 'invalid', reason: 'invalid excludeClientId' };
  }
  return {
    kind: 'ok',
    payload: record.payload,
    excludeClientId,
  };
}

/**
 * Recovers the target user from a subscribed channel name.
 *
 * - strips the `user:` prefix and re-validates the remainder, so a crafted
 *   payload can never redirect delivery to another user.
 *
 * @param channel Channel the message arrived on.
 * @return The branded user, or undefined when the channel is foreign.
 */
export function userIdFromChannel(channel: string): UserId | undefined {
  if (!channel.startsWith(USER_CHANNEL_PREFIX)) {
    return undefined;
  }
  return parseUserId(channel.slice(USER_CHANNEL_PREFIX.length));
}
