/**
 * Unit suite for the user-topic envelope contract.
 *
 * - build: serializes payloads with the exclude key only when an origin
 *   client is given
 * - parse: round-trips built envelopes, drops malformed JSON, non-objects,
 *   missing payloads, and bad exclude ids with a reason and never a throw
 * - channel: channelFor builds `user:{userId}`, userIdFromChannel recovers
 *   it, rejecting foreign channels and blank users.
 */
import { describe, it, expect } from 'vitest';
import { requireClientId, requireUserId } from '../../test/ws-test.helper';
import {
  buildUserTopicEnvelope,
  channelFor,
  parseUserTopicEnvelope,
  userIdFromChannel,
} from './user-topic.message';

describe('user-topic.message', () => {
  it('builds an envelope with just the payload', () => {
    const raw = buildUserTopicEnvelope({ type: 'PING' });

    expect(JSON.parse(raw)).toEqual({
      payload: { type: 'PING' },
    });
  });

  it('carries the origin client when one is excluded', () => {
    const raw = buildUserTopicEnvelope(
      { type: 'PING' },
      requireClientId('client-1'),
    );

    expect(JSON.parse(raw)).toEqual({
      payload: { type: 'PING' },
      excludeClientId: 'client-1',
    });
  });

  it('round-trips a built envelope with its exclude client', () => {
    const raw = buildUserTopicEnvelope(
      { type: 'PING' },
      requireClientId('client-1'),
    );

    const parsed = parseUserTopicEnvelope(raw);

    expect(parsed).toEqual({
      kind: 'ok',
      payload: { type: 'PING' },
      excludeClientId: 'client-1',
    });
  });

  it('parses envelopes without an exclude client', () => {
    const parsed = parseUserTopicEnvelope(JSON.stringify({ payload: 'hi' }));

    expect(parsed).toEqual({
      kind: 'ok',
      payload: 'hi',
      excludeClientId: undefined,
    });
  });

  it('drops malformed JSON without throwing', () => {
    expect(parseUserTopicEnvelope('not-json{')).toEqual({
      kind: 'invalid',
      reason: 'malformed JSON',
    });
  });

  it('drops non-object envelopes without throwing', () => {
    expect(parseUserTopicEnvelope('"just-a-string"')).toEqual({
      kind: 'invalid',
      reason: 'envelope is not an object',
    });
  });

  it('drops envelopes without a payload without throwing', () => {
    expect(
      parseUserTopicEnvelope(JSON.stringify({ excludeClientId: 'client-1' })),
    ).toEqual({ kind: 'invalid', reason: 'missing payload' });
  });

  it('drops blank exclude ids without throwing', () => {
    expect(
      parseUserTopicEnvelope(
        JSON.stringify({
          payload: 1,
          excludeClientId: '   ',
        }),
      ),
    ).toEqual({ kind: 'invalid', reason: 'invalid excludeClientId' });
  });

  it('builds the channel as user:{userId}', () => {
    expect(channelFor(requireUserId('user-123'))).toBe('user:user-123');
  });

  it('recovers the user from its channel', () => {
    expect(userIdFromChannel('user:user-123')).toEqual(
      requireUserId('user-123'),
    );
  });

  it('rejects foreign channels and blank users', () => {
    expect(userIdFromChannel('other:user-123')).toBeUndefined();
    expect(userIdFromChannel('user:   ')).toBeUndefined();
  });
});
