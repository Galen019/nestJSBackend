/**
 * Manages per-user Redis subscriptions for distributed WebSocket delivery.
 *
 * - Subscribes while a user has local sessions; unsubscribes after the last
 * - Retries failed operations on later lifecycle events
 * - Delivers valid messages to local sessions through the `WsModule` hook
 */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { withBoundedRetry } from '../common/retry';
import { quitRedisClient } from '../redis/redis.lifecycle';
import type {
  ClientId,
  SessionLifecycleEvent,
  SessionTracker,
  UserId,
} from '../ws/session.interface';
import type { SubscriberClient } from './subscriber-client';
import {
  channelFor,
  parseUserTopicEnvelope,
  userIdFromChannel,
} from './user-topic.message';

/** DI token for the dedicated pub/sub subscriber connection. */
export const USER_TOPIC_SUBSCRIBER = 'USER_TOPIC_SUBSCRIBER';

/**
 * Bounded retry budget for topic subscribe and unsubscribe operations.
 */
const TOPIC_RETRY = {
  attempts: 5,
  initialDelayMs: 50,
  maxDelayMs: 500,
} as const;

/**
 * Delivers a broadcast to a user's local sessions without a DI cycle.
 *
 * @param userId Owner of the recipient sessions.
 * @param payload Broadcast payload to deliver.
 * @param excludeClientId Origin client to skip on delivery, if any.
 * @return Count of local sessions the message was sent to.
 */
export type LocalUserDeliverer = (
  userId: UserId,
  payload: unknown,
  excludeClientId?: ClientId,
) => number;

/**
 * Tracks user-topic subscriptions in response to session lifecycle events.
 */
@Injectable()
export class UserTopicService
  implements SessionTracker, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(UserTopicService.name);
  private readonly subscribed = new Set<string>();
  private localDeliverer: LocalUserDeliverer | undefined;

  /**
   * Creates the service with its dedicated subscriber connection.
   *
   * @param subscriber Subscriber-only Redis connection from the module factory.
   */
  constructor(
    @Inject(USER_TOPIC_SUBSCRIBER)
    private readonly subscriber: SubscriberClient,
  ) {
    this.subscriber.on('error', (err: Error) => {
      this.logger.error(`User-topic subscriber error: ${err.message}`);
    });
  }

  /**
   * Connects the subscriber on module init with bounded retries.
   *
   * @return Resolves when the subscriber is connected.
   */
  async onModuleInit(): Promise<void> {
    await withBoundedRetry(() => this.subscriber.connect(), {
      failureMessage:
        'Failed to connect user-topic subscriber after 10 attempts',
    });
  }

  /**
   * Quits the subscriber gracefully on module destroy when open.
   *
   * @return Resolves when the subscriber has quit.
   */
  async onModuleDestroy(): Promise<void> {
    await quitRedisClient(this.subscriber);
  }

  /**
   * Claims the user's channel, subscribing unless already claimed.
   *
   * - the claim lands synchronously so concurrent connects subscribe once
   * - the SUBSCRIBE settles via `withTopicOp`; a connect arriving after an
   *   exhausted subscribe finds no claim and retries it.
   *
   * @param event Session identity for the new connection.
   * @return Resolves when the subscribe settles or the claim is released.
   */
  async handleConnect(event: SessionLifecycleEvent): Promise<void> {
    const channel = channelFor(event.userId);
    if (this.subscribed.has(channel)) {
      return;
    }
    this.subscribed.add(channel);
    await this.withTopicOp(channel, 'subscribe', () =>
      this.subscriber.subscribe(channel, (message: string, ch: string): void =>
        this.handleTopicMessage(message, ch),
      ),
    );
  }

  /**
   * Unsubscribes the user's channel when its last session disconnects.
   *
   * - sessions remaining for the user keep the subscription untouched
   * - unclaimed channels are a no-op so duplicated closes stay safe.
   *
   * @param event Session identity plus the remaining user total.
   * @return Resolves when the unsubscribe settles.
   */
  async handleDisconnect(event: SessionLifecycleEvent): Promise<void> {
    if (event.userSessionCount > 0) {
      return;
    }
    const channel = channelFor(event.userId);
    if (!this.subscribed.has(channel)) {
      return;
    }
    this.subscribed.delete(channel);
    await this.withTopicOp(channel, 'unsubscribe', () =>
      this.subscriber.unsubscribe(channel),
    );
  }

  /**
   * Retries a topic operation, logs failures, and leaves it recoverable.
   *
   * @param channel Channel to (un)subscribe.
   * @param op Which operation is running, for messages and claim handling.
   * @param task The subscribe/unsubscribe call to retry.
   * @return Resolves when the op settles or its failure is absorbed.
   */
  private async withTopicOp(
    channel: string,
    op: 'subscribe' | 'unsubscribe',
    task: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await withBoundedRetry(task, {
        ...TOPIC_RETRY,
        failureMessage: `Failed to ${op} ${channel} after ${TOPIC_RETRY.attempts} attempts`,
      });
    } catch (err: unknown) {
      if (op === 'subscribe') {
        this.subscribed.delete(channel);
      }
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        op === 'subscribe'
          ? `Failed to subscribe ${channel}: ${detail}; will retry on the next connect`
          : `Failed to unsubscribe ${channel}: ${detail}; the next subscribe heals it`,
      );
    }
  }

  /**
   * Registers the local-delivery hook for inbound topic messages.
   *
   * - single wiring point owned by `WsModule`: the registry passes its
   *   `sendToLocalUser`, so this service delivers without depending on the
   *   registry and without forming a DI cycle.
   *
   * @param deliverer Function delivering to the local sessions of a user.
   */
  setLocalDeliverer(deliverer: LocalUserDeliverer): void {
    this.localDeliverer = deliverer;
  }

  /**
   * Validates and delivers a topic message to local sessions
   *
   * @param message Raw channel payload.
   * @param channel Channel the message arrived on.
   */
  private handleTopicMessage(message: string, channel: string): void {
    const userId = userIdFromChannel(channel);
    if (userId === undefined) {
      this.logger.warn(`Dropping topic message on foreign channel ${channel}`);
      return;
    }
    const parsed = parseUserTopicEnvelope(message);
    if (parsed.kind === 'invalid') {
      this.logger.warn(
        `Dropping topic message on ${channel}: ${parsed.reason}`,
      );
      return;
    }
    if (this.localDeliverer === undefined) {
      throw new Error(
        `Dropping topic message on ${channel}: local deliverer not registered (WsModule wiring missing)`,
      );
    }
    const delivered = this.localDeliverer(
      userId,
      parsed.payload,
      parsed.excludeClientId,
    );
    this.logger.debug(
      `Topic message on ${channel}: ${Buffer.byteLength(message, 'utf8')} bytes to ${delivered} local sessions`,
    );
  }
}
