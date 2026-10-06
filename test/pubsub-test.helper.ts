/**
 * Test-only shared in-memory Redis pub/sub bus (no real Redis).
 *
 * - one bus stands in for the Redis server when suites run several
 *   replicas in one process: every connected fake publishes into it and
 *   every subscription registers a listener on it
 * - mirrors Redis pub/sub semantics: delivery is channel-scoped and
 *   at-most-once, and `publish` resolves with the listener count reached
 * - unsubscribe only detaches channels the same fake subscribed, so one
 *   replica can never drop a sibling's subscription.
 */
import type { TopicListener } from '../src/user-topics/subscriber-client';
import type { PublisherFake } from './publisher-test.helper';
import type { SubscriberFake } from './subscriber-test.helper';

/**
 * Channel-to-listeners routing table shared by one test's fakes.
 */
export type PubSubBus = Map<string, Set<TopicListener>>;

/**
 * Creates an empty bus for one test.
 *
 * @return The routing table the test's fakes share.
 */
export function createPubSubBus(): PubSubBus {
  return new Map<string, Set<TopicListener>>();
}

/**
 * Routes one subscriber fake through the shared bus.
 *
 * @param subscriber Subscriber fake to attach.
 * @param bus Routing table shared with the test's publishers.
 */
export function connectSubscriberToBus(
  subscriber: SubscriberFake,
  bus: PubSubBus,
): void {
  const owned = new Map<string, TopicListener>();
  subscriber.subscribe.mockImplementation(
    async (channel: string, listener: TopicListener): Promise<void> => {
      owned.set(channel, listener);
      let listeners = bus.get(channel);
      if (listeners === undefined) {
        listeners = new Set<TopicListener>();
        bus.set(channel, listeners);
      }
      listeners.add(listener);
    },
  );
  subscriber.unsubscribe.mockImplementation(
    async (channel?: string): Promise<void> => {
      if (channel === undefined) {
        for (const [ownedChannel, listener] of owned) {
          bus.get(ownedChannel)?.delete(listener);
        }
        owned.clear();
        return;
      }
      const listener = owned.get(channel);
      if (listener !== undefined) {
        bus.get(channel)?.delete(listener);
        owned.delete(channel);
      }
    },
  );
}

/**
 * Routes one publisher fake through the shared bus.
 *
 * @param publisher Publisher fake to attach.
 * @param bus Routing table shared with the test's subscribers.
 */
export function connectPublisherToBus(
  publisher: PublisherFake,
  bus: PubSubBus,
): void {
  publisher.publish.mockImplementation(
    async (channel: string, message: string): Promise<number> => {
      const listeners = bus.get(channel);
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          listener(message, channel);
        }
      }
      return listeners?.size ?? 0;
    },
  );
}
