/**
 * Bounded exponential-backoff retry for boot-time dependency connects.
 *
 * - single owner of the connect-retry policy shared by Redis and DynamoDB
 * - attempts `task` up to `attempts` times with exponential delay capped at max
 * - rethrows the last error when all attempts fail.
 */
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Tuning knobs for `withBoundedRetry`.
 */
export interface BoundedRetryOptions {
  /** Total attempts including the first try. Defaults to 10. */
  attempts?: number;
  /** Delay before the second attempt, doubled per retry. Defaults to 500ms. */
  initialDelayMs?: number;
  /** Upper bound for the backoff delay. Defaults to 5000ms. */
  maxDelayMs?: number;
  /** Called after each failed attempt except when attempts are exhausted. */
  onAttemptFailed?: (attempt: number, attempts: number, err: unknown) => void;
  /** Fallback message when the last failure is not an `Error`. */
  failureMessage?: string;
}

/**
 * Sleeps for the given duration.
 *
 * @param ms Milliseconds to wait.
 * @return Resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `task` with bounded exponential-backoff retries.
 *
 * - resolves with the task result on the first success without further delay
 * - waits with exponential delay capped at `maxDelayMs` between attempts
 * - reports each failure via `onAttemptFailed` before sleeping
 * - rethrows the last error when all attempts fail, or `failureMessage` when it is not an `Error`.
 *
 * @param task Async probe to retry (connect, ping).
 * @param options Attempt budget, delays, and failure hooks.
 * @return The task result from the first successful attempt.
 */
export async function withBoundedRetry<T>(
  task: () => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        options.onAttemptFailed?.(attempt, attempts, err);
        await sleep(Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(options.failureMessage ?? `Failed after ${attempts} attempts`);
}
