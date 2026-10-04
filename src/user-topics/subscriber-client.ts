/**
 * Narrow Redis subscriber surface (type-only, no runtime code).
 *
 * - documents the only subscriber operations `UserTopicService` needs
 * - real `RedisClientType` instances satisfy this structurally, enforced by
 *   the module factory's declared return type
 * - test fakes implement this shape directly, no casts at the boundary.
 */
import type { RedisLifecycleClient } from '../redis/redis.lifecycle';

/**
 * Listener invoked per pub/sub message.
 *
 * - mirrors the client listener shape: message plus the channel it arrived on.
 */
export type TopicListener = (message: string, channel: string) => unknown;

/**
 * Minimal subscriber-only connection.
 *
 * - extends the shared lifecycle surface with pub/sub operations
 * - stays separate from command clients because a subscribed connection
 *   cannot run regular commands.
 */
export interface SubscriberClient extends RedisLifecycleClient {
  subscribe(channel: string, listener: TopicListener): Promise<unknown>;
  unsubscribe(channel?: string): Promise<unknown>;
}
