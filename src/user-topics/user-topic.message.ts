/**
 * Defines and validates Redis envelopes for per-user WebSocket fan-out.
 * The channel determines the target user; an optional client ID prevents
 * sender echoes. Invalid messages return errors rather than throwing.
 */

import {
  parseClientId,
  parseUserId,
  type ClientId,
  type UserId,
} from '../ws/session.interface';

/** Prefix for per-user Redis channels. */
const USER_CHANNEL_PREFIX = 'user:';

/** Message published to a user's channel. */
export interface UserTopicEnvelope {
  payload: unknown;
  excludeClientId?: ClientId;
}

/** Result of parsing a channel payload. */
export type ParseEnvelopeResult =
  | { kind: 'ok'; payload: unknown; excludeClientId: ClientId | undefined }
  | { kind: 'invalid'; reason: string };

/**
 * Builds a user's Redis channel.
 *
 * @param userId Owner of the connections.
 * @return The Redis pub/sub channel for the user.
 */
export function channelFor(userId: UserId): string {
  return `${USER_CHANNEL_PREFIX}${userId}`;
}

/**
 * Serializes a broadcast envelope; throws if serialization fails.
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
 * Parses a channel message, returning a reason for invalid envelopes.
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
 * Validates and extracts the user ID from a channel name.
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
