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
  extractGatewayIdentity,
  parseClientId,
  parseNonBlank,
  parseToken,
  parseUserId,
  resolveGatewayIdentity,
  type GatewayIdentity,
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
