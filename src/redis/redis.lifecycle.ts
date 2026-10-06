/**
 * Shared quit helper for Redis connections.
 *
 * - single owner of the graceful-destroy policy used by every client
 * - callers connect via the shared `withBoundedRetry` helper directly and
 *   attach `error` listeners via `client.on` directly; only the is-open
 *   guard is shared, because it is the one decision every destroy repeats.
 */

/**
 * Minimal Redis connection surface the quit helper needs.
 *
 * - real `RedisClientType` instances satisfy this structurally
 * - test fakes implement this shape without casts.
 */
export interface RedisLifecycleClient {
  readonly isOpen: boolean;
  quit(): Promise<unknown>;
}

/**
 * Quits a Redis client gracefully when it is open.
 *
 * - skips quit on closed clients so destroy stays a no-op without a connection.
 *
 * @param client Connection to close.
 * @return Resolves when the client has quit or was already closed.
 */
export async function quitRedisClient(
  client: RedisLifecycleClient,
): Promise<void> {
  if (client.isOpen) {
    await client.quit();
  }
}
