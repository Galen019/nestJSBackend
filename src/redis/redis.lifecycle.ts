/**
 * Shared lifecycle helpers for Redis connections.
 *
 * - single owner of the connect-retry/quit/error wiring used by every client
 * - keeps the command and subscriber lifecycles identical without a base class
 * - callers stay thin: attach the error handler in the constructor, connect on
 *   module init, quit on module destroy.
 */
import { withBoundedRetry, type BoundedRetryOptions } from '../common/retry';

/**
 * Minimal Redis connection surface the lifecycle helpers need.
 *
 * - real `RedisClientType` instances satisfy this structurally
 * - test fakes implement this shape without casts.
 */
export interface RedisLifecycleClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Attaches a best-effort error reporter to a Redis connection.
 *
 * @param client Connection to observe for `error` events.
 * @param report Receives each client error, usually to log it.
 */
export function attachRedisErrorHandler(
  client: RedisLifecycleClient,
  report: (err: Error) => void,
): void {
  client.on('error', (err: Error) => {
    report(err);
  });
}

/**
 * Connects a Redis client with bounded exponential-backoff retries.
 *
 * - delegates the retry policy to the shared `withBoundedRetry` helper
 * - throws the last error when all attempts fail.
 *
 * @param client Connection to open.
 * @param failureMessage Reported when the last failure is not an `Error`.
 * @param options Attempt budget and delays, defaults to the shared policy.
 * @return Resolves when the client is connected.
 */
export async function connectRedisClient(
  client: RedisLifecycleClient,
  failureMessage: string,
  options: BoundedRetryOptions = {},
): Promise<void> {
  await withBoundedRetry(
    async (): Promise<void> => {
      await client.connect();
    },
    { ...options, failureMessage },
  );
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
