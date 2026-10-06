/**
 * Minimal publisher type used by `WsService` and its test fakes.
 */

/**
 * TypeScript is structurally typed: `RedisClientType` fits because it has a
 * compatible `publish` method; no explicit implementation class is needed.
 */
export interface PublisherClient {
  /**
   * Publishes one message to a channel.
   *
   * @param channel Channel to publish to.
   * @param message Serialized envelope to deliver to subscribers.
   * @return Resolves with the subscriber count reached.
   */
  publish(channel: string, message: string): Promise<number>;
}
