/**
 * Test-only Redis publisher stub (no real Redis).
 *
 * - stands in for `REDIS_CLIENT` where specs need `publish` without a server
 * - matches the `PublisherClient` surface so fakes need no casts.
 */
import { vi } from 'vitest';

/**
 * Creates a fresh publisher stub with a mocked `publish`.
 *
 * @return Fake publisher plus its mocks.
 */
export function createPublisherFake() {
  return {
    publish: vi
      .fn<(channel: string, message: string) => Promise<number>>()
      .mockResolvedValue(1),
  };
}

/**
 * Publisher stub type shared by unit and e2e suites.
 */
export type PublisherFake = ReturnType<typeof createPublisherFake>;
