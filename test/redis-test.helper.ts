/**
 * Test-only RedisService stub (no real Redis).
 *
 * - stands in for `RedisService` via `overrideProvider`/`useValue`
 * - `ping`/`isReady` report healthy by default
 * - `getEntry`/`set` are bare mocks each test programs per case.
 */
import { vi } from 'vitest';
import type { SetOptions } from 'redis';
import type { RedisEntry } from '../src/redis/redis.service';

/**
 * Creates a fresh Redis stub with mocked `ping`/`isReady`/`getEntry`/`set`.
 *
 * @return Fake Redis plus its mocks.
 */
export function createRedisFake() {
  return {
    ping: vi.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    isReady: vi.fn<() => boolean>().mockReturnValue(true),
    getEntry: vi.fn<(key: string) => Promise<RedisEntry | null>>(),
    set: vi.fn<
      (
        key: string,
        value: string,
        options?: SetOptions,
      ) => Promise<string | null>
    >(),
  };
}

/**
 * Redis stub type shared by unit and e2e suites.
 */
export type RedisFake = ReturnType<typeof createRedisFake>;
