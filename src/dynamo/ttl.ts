/**
 * DynamoDB per-item TTL helpers for expiring tables.
 *
 * - owns the shared `expiresAt` attribute, the 30-day inbox lifetime, the
 *   1-day client-presence lifetime, and the builder used on expiring writes
 * - DynamoDB TTL deletes per item, not per table: enabling TimeToLive only
 *   arms the attribute, each PutItem must still carry `expiresAt` in epoch seconds
 * - `User` rows are permanent by design and never carry `expiresAt`.
 */

/**
 * TTL attribute shared by expiring tables, written by the app as epoch seconds.
 */
export const TTL_ATTRIBUTE_NAME = 'expiresAt';

/**
 * Per-item lifetime for expiring tables (30 days in seconds).
 */
export const EXPIRING_ITEM_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Per-item lifetime for client-presence rows (1 day in seconds).
 *
 * - crash-safety net only; explicit disconnect deletes the row first
 * - kept separate from inbox retention so the two lifetimes cannot drift together.
 */
export const CLIENT_PRESENCE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Builds the per-item `expiresAt` value for expiring writes.
 *
 * - defaults to now plus `ttlSeconds`; pass an explicit base for tests
 * - `ttlSeconds` comes first so presence (1 day) and inbox (30 days) share one builder.
 *
 * @param ttlSeconds Lifetime in seconds, defaults to the 30-day inbox lifetime.
 * @param nowEpochSeconds Base time in epoch seconds, defaults to the current time.
 * @return Epoch seconds at which the item should expire.
 */
export function buildExpiresAt(
  ttlSeconds: number = EXPIRING_ITEM_TTL_SECONDS,
  nowEpochSeconds?: number,
): number {
  const base = nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  return base + ttlSeconds;
}
