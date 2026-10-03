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
 * @return Fake with a `ping` mock resolving to undefined.
 */
export function createDynamoFake(): {
  ping: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    ping: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/**
 * DynamoDB readiness stub type shared by unit and e2e suites.
 */
export type DynamoFake = ReturnType<typeof createDynamoFake>;
