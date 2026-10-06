/**
 * Narrow Redis subscriber surface (type-only, no runtime code).
 *
 * - documents the only subscriber operations `UserTopicService` needs
 * - real `RedisClientType` instances satisfy this structurally, enforced by
 *   the module factory's declared return type
 * - test fakes implement this shape directly, no casts at the boundary
 * - structurally satisfies `RedisLifecycleClient`, so destroy reuses the
 *   shared quit helper without coupling to it.
 */

/**
 * Listener invoked per pub/sub message.
 *
 * - mirrors the client listener shape: message plus the channel it arrived on.
 */
export type TopicListener = (message: string, channel: string) => unknown;

/**
 * Minimal subscriber-only connection.
 *
 * - carries its own lifecycle surface plus pub/sub operations
 * - stays separate from command clients because a subscribed connection
 *   cannot run regular commands.
 */
export interface SubscriberClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (err: Error) => void): unknown;
  subscribe(channel: string, listener: TopicListener): Promise<unknown>;
  unsubscribe(channel?: string): Promise<unknown>;
}
