/**
 * Test-only Redis subscriber stub (no real Redis).
 *
 * - stands in for `USER_TOPIC_SUBSCRIBER` via `overrideProvider`/`useValue`
 * - matches the `SubscriberClient` surface so fakes need no casts
 * - defaults `isOpen` to false so destroy skips quit unless a test opts in.
 */
import { vi } from 'vitest';
import type { TopicListener } from '../src/user-topics/subscriber-client';

/**
 * Creates a fresh subscriber stub with mocked `connect`/`quit`/`subscribe`/`unsubscribe`/`on`.
 *
 * @return Fake subscriber plus its mocks.
 */
export function createSubscriberFake() {
  return {
    isOpen: false,
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
    subscribe: vi
      .fn<(channel: string, listener: TopicListener) => Promise<void>>()
      .mockResolvedValue(undefined),
    unsubscribe: vi
      .fn<(channel?: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    on: vi
      .fn<(event: string, listener: (err: Error) => void) => unknown>()
      .mockReturnValue(undefined),
  };
}

/**
 * Subscriber stub type shared by unit and e2e suites.
 */
export type SubscriberFake = ReturnType<typeof createSubscriberFake>;
