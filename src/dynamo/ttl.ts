/** Per-item TTL settings for expiring DynamoDB records; User rows are permanent. */

/** Shared TTL attribute, stored as epoch seconds. */
export const TTL_ATTRIBUTE_NAME = 'expiresAt';

/** Default item lifetime: 30 days. */
export const EXPIRING_ITEM_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Client-presence lifetime: one day; explicit disconnect deletes rows sooner.
 */
export const CLIENT_PRESENCE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Builds an expiration timestamp from a lifetime and optional base time.
 *
 * @param ttlSeconds Lifetime in seconds; defaults to 30 days.
 * @param nowEpochSeconds Base epoch time; defaults to now.
 * @return Expiration time in epoch seconds.
 */
export function buildExpiresAt(
  ttlSeconds: number = EXPIRING_ITEM_TTL_SECONDS,
  nowEpochSeconds?: number,
): number {
  const base = nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  return base + ttlSeconds;
}
