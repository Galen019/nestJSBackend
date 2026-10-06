/**
 * Unit suite for gateway identity parsing and resolution.
 *
 * - parseNonBlank: single owner of the non-blank check behind every parser
 * - branded parsers: ids and tokens delegate, blank values become undefined
 * - extract: upgrade URL query becomes branded ids plus the raw token
 * - resolve: authorized only for a verified token with `sub` bound to
 *   `userId`; every other shape rejects without touching the verifier more
 *   than once or at all.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  canSendTo,
  extractGatewayIdentity,
  parseClientId,
  parseInboundFrame,
  parseNonBlank,
  parseToken,
  parseUserId,
  resolveGatewayIdentity,
  SEND_MESSAGE_OP,
  type GatewayIdentity,
  type UserId,
} from './session.interface';

/**
 * Builds an identity with a verified subject for resolve tests.
 *
 * @param overrides Identity fields to replace.
 * @return The gateway identity under test.
 */
function makeIdentity(
  overrides: Partial<GatewayIdentity> = {},
): GatewayIdentity {
  return {
    userId: parseUserId('user-123'),
    clientId: parseClientId('client-456'),
    token: 'good',
    ...overrides,
  };
}

describe('parseNonBlank', () => {
  it('returns the string when it carries content', () => {
    expect(parseNonBlank('user-123')).toBe('user-123');
  });

  it('rejects missing, blank, and non-string values', () => {
    expect(parseNonBlank(undefined)).toBeUndefined();
    expect(parseNonBlank('')).toBeUndefined();
    expect(parseNonBlank('   ')).toBeUndefined();
    expect(parseNonBlank(42)).toBeUndefined();
    expect(parseNonBlank(null)).toBeUndefined();
  });
});

describe('branded identity parsers', () => {
  it('brands parsed ids and passes tokens through', () => {
    expect(parseUserId('user-123')).toBe('user-123');
    expect(parseClientId('client-456')).toBe('client-456');
    expect(parseToken('good')).toBe('good');
  });

  it('returns undefined for blank values', () => {
    expect(parseUserId('   ')).toBeUndefined();
    expect(parseClientId('')).toBeUndefined();
    expect(parseToken(undefined)).toBeUndefined();
  });
});

describe('extractGatewayIdentity', () => {
  it('parses userId, clientId, and token from the upgrade URL', () => {
    const identity = extractGatewayIdentity([
      { url: '/ws?userId=user-123&clientId=client-456&token=good' },
    ]);

    expect(identity).toEqual({
      userId: 'user-123',
      clientId: 'client-456',
      token: 'good',
    });
  });

  it('returns undefined values when no URL is present', () => {
    expect(extractGatewayIdentity([])).toEqual({
      userId: undefined,
      clientId: undefined,
      token: undefined,
    });
    expect(extractGatewayIdentity([{}])).toEqual({
      userId: undefined,
      clientId: undefined,
      token: undefined,
    });
  });
});

describe('resolveGatewayIdentity', () => {
  it('authorizes a verified token with sub bound to userId', () => {
    const verify = vi.fn(() => ({ sub: 'user-123' }));

    const result = resolveGatewayIdentity(makeIdentity(), verify);

    expect(result).toEqual({
      kind: 'authorized',
      userId: 'user-123',
      clientId: 'client-456',
    });
    expect(verify).toHaveBeenCalledWith('good');
  });

  it('rejects a missing token without calling the verifier', () => {
    const verify = vi.fn(() => ({ sub: 'user-123' }));

    const result = resolveGatewayIdentity(
      makeIdentity({ token: undefined }),
      verify,
    );

    expect(result).toEqual({ kind: 'rejected', reason: 'missing token' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', () => {
    const verify = vi.fn(() => {
      throw new Error('bad token');
    });

    const result = resolveGatewayIdentity(makeIdentity(), verify);

    expect(result).toEqual({ kind: 'rejected', reason: 'invalid token' });
  });

  it('rejects a verified token that carries no subject', () => {
    const verify = vi.fn(() => ({}));

    const result = resolveGatewayIdentity(makeIdentity(), verify);

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'missing token subject',
    });
  });

  it('rejects missing ids despite a valid token', () => {
    const verify = vi.fn(() => ({ sub: 'user-123' }));

    const result = resolveGatewayIdentity(
      makeIdentity({ userId: undefined, clientId: undefined }),
      verify,
    );

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'missing userId/clientId',
    });
  });

  it('rejects a sub/userId mismatch', () => {
    const verify = vi.fn(() => ({ sub: 'other-user' }));

    const result = resolveGatewayIdentity(makeIdentity(), verify);

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'token subject mismatch',
    });
  });
});

/**
 * Requires a branded user id for parser tests, failing fast on bad literals.
 *
 * @param value Literal user id used by the test.
 * @return The branded user id.
 */
function mustUserId(value: string): UserId {
  const parsed = parseUserId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test userId: ${value}`);
  }
  return parsed;
}

describe('parseInboundFrame', () => {
  it('parses a sendMessage frame with a string payload', () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        op: SEND_MESSAGE_OP,
        target: 'user-2',
        message: 'PING',
      }),
    );

    expect(frame).toEqual({
      kind: 'send',
      target: 'user-2',
      message: 'PING',
    });
  });

  it('passes object payloads through verbatim', () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        op: SEND_MESSAGE_OP,
        target: 'user-2',
        message: { text: 'hi' },
      }),
    );

    expect(frame).toEqual({
      kind: 'send',
      target: 'user-2',
      message: { text: 'hi' },
    });
  });

  it('ignores non-JSON frames', () => {
    expect(parseInboundFrame('hello-payload')).toEqual({
      kind: 'ignore',
      reason: 'non-JSON',
    });
  });

  it('ignores non-object JSON frames', () => {
    expect(parseInboundFrame(JSON.stringify(42))).toEqual({
      kind: 'ignore',
      reason: 'non-object',
    });
    expect(parseInboundFrame(JSON.stringify('hi'))).toEqual({
      kind: 'ignore',
      reason: 'non-object',
    });
  });

  it('ignores unknown ops', () => {
    expect(
      parseInboundFrame(JSON.stringify({ op: 'other', target: 'user-2' })),
    ).toEqual({ kind: 'ignore', reason: 'unknown op' });
  });

  it('marks blank targets as invalid', () => {
    expect(
      parseInboundFrame(
        JSON.stringify({ op: SEND_MESSAGE_OP, target: '   ', message: 'PING' }),
      ),
    ).toEqual({ kind: 'invalid', reason: 'invalid target' });
    expect(
      parseInboundFrame(
        JSON.stringify({ op: SEND_MESSAGE_OP, message: 'PING' }),
      ),
    ).toEqual({ kind: 'invalid', reason: 'invalid target' });
  });

  it('ignores sendMessage frames without a message', () => {
    expect(
      parseInboundFrame(
        JSON.stringify({ op: SEND_MESSAGE_OP, target: 'user-2' }),
      ),
    ).toEqual({ kind: 'ignore', reason: 'missing message' });
  });
});

describe('canSendTo', () => {
  it('allows open DM between any two users', () => {
    expect(canSendTo(mustUserId('user-1'), mustUserId('user-2'))).toBe(true);
    expect(canSendTo(mustUserId('user-1'), mustUserId('user-1'))).toBe(true);
  });
});
