/**
 * Test-only DynamoService stub (no real DynamoDB).
 *
 * - stands in for `DynamoService` via `overrideProvider`/`useValue`
 * - `ping` resolves by default; reject once per case for 503 paths.
 */
import { vi } from 'vitest';

/**
 * Creates a fresh DynamoDB readiness stub.
 *
 * - `ping` resolves by default; reject once per case for 503 paths
 * - `getClient` returns a `send` stub resolving to `{}` so presence
 *   writes settle without a real DynamoDB.
 *
 * @return Fake with `ping` and `getClient` mocks.
 */
export function createDynamoFake(): {
  ping: ReturnType<typeof vi.fn<() => Promise<void>>>;
  getClient: ReturnType<typeof vi.fn<() => { send: unknown }>>;
} {
  const send = vi
    .fn<(command: unknown) => Promise<unknown>>()
    .mockResolvedValue({});
  return {
    ping: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getClient: vi.fn<() => { send: unknown }>().mockReturnValue({ send }),
  };
}

/**
 * DynamoDB readiness stub type shared by unit and e2e suites.
 */
export type DynamoFake = ReturnType<typeof createDynamoFake>;
