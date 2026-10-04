/**
 * Test suite for DynamoDB per-item TTL helpers.
 *
 * - guards the 30-day inbox lifetime and the 1-day presence lifetime
 * - covers expiresAt from an explicit base and from the current time
 * - locks the flipped `(ttlSeconds, now)` arg order as a regression guard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CLIENT_PRESENCE_TTL_SECONDS,
  EXPIRING_ITEM_TTL_SECONDS,
  buildExpiresAt,
} from './ttl';

describe('ttl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets a 30-day lifetime for expiring items', () => {
    expect(EXPIRING_ITEM_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('sets a 1-day lifetime for presence items', () => {
    expect(CLIENT_PRESENCE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('builds expiresAt as base plus 30 days by default', () => {
    expect(buildExpiresAt(EXPIRING_ITEM_TTL_SECONDS, 1_000_000)).toBe(
      1_000_000 + EXPIRING_ITEM_TTL_SECONDS,
    );
    expect(buildExpiresAt(undefined, 1_000_000)).toBe(
      1_000_000 + EXPIRING_ITEM_TTL_SECONDS,
    );
  });

  it('builds presence expiresAt as base plus 1 day', () => {
    expect(buildExpiresAt(CLIENT_PRESENCE_TTL_SECONDS, 1_000_000)).toBe(
      1_000_000 + CLIENT_PRESENCE_TTL_SECONDS,
    );
  });

  it('builds expiresAt from the current time by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(buildExpiresAt()).toBe(nowSeconds + EXPIRING_ITEM_TTL_SECONDS);
    expect(buildExpiresAt(CLIENT_PRESENCE_TTL_SECONDS)).toBe(
      nowSeconds + CLIENT_PRESENCE_TTL_SECONDS,
    );
  });
});
