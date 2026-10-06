/**
 * Minimal subscriber type for `UserTopicService` and its test fakes.
 * `RedisClientType` satisfies it structurally and supports shared cleanup.
 */

/**
 * Listener invoked per pub/sub message
 */
export type TopicListener = (message: string, channel: string) => unknown;

/**
 * Dedicated connection for Redis pub/sub subscriptions.
 */
export interface SubscriberClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (err: Error) => void): unknown;
  subscribe(channel: string, listener: TopicListener): Promise<unknown>;
  unsubscribe(channel?: string): Promise<unknown>;
}
