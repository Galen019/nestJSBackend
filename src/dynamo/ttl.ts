/**
 * DynamoDB per-item TTL helpers for expiring tables.
 *
 * - owns the shared `expiresAt` attribute, the 30-day lifetime, and the
 *   builder used on Inbox/Message writes
 * - DynamoDB TTL deletes per item, not per table: enabling TimeToLive only
 *   arms the attribute, each PutItem must still carry `expiresAt` in epoch seconds.
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
 * Builds the per-item `expiresAt` value for Inbox/Message writes.
 *
 * - defaults to now plus 30 days; pass an explicit base for tests.
 *
 * @param nowEpochSeconds Base time in epoch seconds, defaults to the current time.
 * @return Epoch seconds at which the item should expire.
 */
export function buildExpiresAt(nowEpochSeconds?: number): number {
  const base = nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  return base + EXPIRING_ITEM_TTL_SECONDS;
}
