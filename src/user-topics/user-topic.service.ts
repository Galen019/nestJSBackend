/**
 * Per-user Redis SUBSCRIBE lifecycle for distributed WS fan-out.
 *
 * - implements `SessionTracker`: subscribes `user:{userId}` while the user
 *   holds local sessions, unsubscribes when the last one disconnects
 * - owns one dedicated subscriber connection plus the set of claimed channels
 * - keeps no connection counts: `WsService` owns the per-user totals and
 *   reports them per event, this service only tracks what it subscribed
 * - best-effort only: (un)subscribe runs in the background with bounded
 *   retries and never throws to the caller, sockets never block
 * - a failed subscribe releases its claim so the next connect retries; a
 *   failed unsubscribe heals on the next subscribe
 * - channels are ephemeral, no stale state survives a restart, no cleanup job needed
 * - debug-only message listener, no routing or delivery in this step.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { withBoundedRetry } from '../common/retry';
import {
  attachRedisErrorHandler,
  connectRedisClient,
  quitRedisClient,
} from '../redis/redis.lifecycle';
import type {
  SessionLifecycleEvent,
  SessionTracker,
  UserId,
} from '../ws/session.interface';
import type { SubscriberClient } from './subscriber-client';

/** DI token for the dedicated pub/sub subscriber connection. */
export const USER_TOPIC_SUBSCRIBER = 'USER_TOPIC_SUBSCRIBER';

/** Subscribe/unsubscribe retry budget: 5 attempts, then heal on next connect. */
const TOPIC_ATTEMPTS = 5;

/** Delay before the second (un)subscribe attempt, doubled per retry. */
const TOPIC_INITIAL_DELAY_MS = 50;

/** Upper bound for the (un)subscribe backoff delay. */
const TOPIC_MAX_DELAY_MS = 500;

/**
 * Builds the channel name for one user.
 *
 * @param userId Owner of the connections.
 * @return The Redis pub/sub channel for the user.
 */
export function channelFor(userId: UserId): string {
  return `user:${userId}`;
}

/**
 * Tracks per-user subscriptions as a `SessionTracker`.
 *
 * - connect claims the channel and subscribes unless already claimed, so a
 *   later connect retries a subscribe that previously exhausted its budget
 * - disconnect unsubscribes only when no local sessions remain for the user
 * - the claim set holds channels with a live or in-flight subscription, never
 *   connection counts, so it cannot drift from the registry.
 */
@Injectable()
export class UserTopicService
  implements SessionTracker, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(UserTopicService.name);
  private readonly subscribed = new Set<string>();

  /**
   * Creates the service with its dedicated subscriber connection.
   *
   * @param subscriber Subscriber-only Redis connection from the module factory.
   */
  constructor(
    @Inject(USER_TOPIC_SUBSCRIBER)
    private readonly subscriber: SubscriberClient,
  ) {
    attachRedisErrorHandler(this.subscriber, (err: Error) => {
      this.logger.error(`User-topic subscriber error: ${err.message}`);
    });
  }

  /**
   * Connects the subscriber on module init with bounded retries.
   *
   * @return Resolves when the subscriber is connected.
   */
  async onModuleInit(): Promise<void> {
    await connectRedisClient(
      this.subscriber,
      'Failed to connect user-topic subscriber after 10 attempts',
    );
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
   * - the SUBSCRIBE runs in the background; a connect arriving after an
   *   exhausted subscribe finds no claim and retries it.
   *
   * @param event Session identity for the new connection.
   */
  handleConnect(event: SessionLifecycleEvent): void {
    const channel = channelFor(event.userId);
    if (this.subscribed.has(channel)) {
      return;
    }
    this.subscribed.add(channel);
    void this.subscribeWithRetry(channel);
  }

  /**
   * Unsubscribes the user's channel when its last session disconnects.
   *
   * - sessions remaining for the user keep the subscription untouched
   * - unclaimed channels are a no-op so duplicated closes stay safe.
   *
   * @param event Session identity plus the remaining user total.
   */
  handleDisconnect(event: SessionLifecycleEvent): void {
    if (event.userSessionCount > 0) {
      return;
    }
    const channel = channelFor(event.userId);
    if (!this.subscribed.has(channel)) {
      return;
    }
    this.subscribed.delete(channel);
    void this.unsubscribeWithRetry(channel);
  }

  /**
   * Observes one pub/sub message for a subscribed user channel.
   *
   * - debug-only hook, logs channel plus byte length without bodies
   * - delivery and routing plug in later without changing lifecycle.
   *
   * @param message Raw channel payload.
   * @param channel Channel the message arrived on.
   */
  private handleTopicMessage(message: string, channel: string): void {
    this.logger.debug(
      `Topic message on ${channel}: ${Buffer.byteLength(message, 'utf8')} bytes`,
    );
  }

  /**
   * Subscribes to one user channel with bounded retries.
   *
   * - releases the claim when the budget is exhausted so the next connect
   *   retries instead of leaving the channel silently unsubscribed
   * - never throws to the caller.
   *
   * @param channel Channel to subscribe to.
   * @return Resolves when the subscribe settles or the claim is released.
   */
  private async subscribeWithRetry(channel: string): Promise<void> {
    try {
      await withBoundedRetry(
        async (): Promise<void> => {
          await this.subscriber.subscribe(
            channel,
            (message: string, ch: string): void =>
              this.handleTopicMessage(message, ch),
          );
        },
        {
          attempts: TOPIC_ATTEMPTS,
          initialDelayMs: TOPIC_INITIAL_DELAY_MS,
          maxDelayMs: TOPIC_MAX_DELAY_MS,
          failureMessage: `Failed to subscribe ${channel} after ${TOPIC_ATTEMPTS} attempts`,
        },
      );
    } catch (err: unknown) {
      this.subscribed.delete(channel);
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Failed to subscribe ${channel}: ${detail}; will retry on the next connect`,
      );
    }
  }

  /**
   * Unsubscribes from one user channel with bounded retries.
   *
   * - the claim is already released, so a failed unsubscribe heals on the
   *   next subscribe, which re-subscribes idempotently
   * - never throws to the caller.
   *
   * @param channel Channel to unsubscribe from.
   * @return Resolves when the unsubscribe settles.
   */
  private async unsubscribeWithRetry(channel: string): Promise<void> {
    try {
      await withBoundedRetry(
        async (): Promise<void> => {
          await this.subscriber.unsubscribe(channel);
        },
        {
          attempts: TOPIC_ATTEMPTS,
          initialDelayMs: TOPIC_INITIAL_DELAY_MS,
          maxDelayMs: TOPIC_MAX_DELAY_MS,
          failureMessage: `Failed to unsubscribe ${channel} after ${TOPIC_ATTEMPTS} attempts`,
        },
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Failed to unsubscribe ${channel}: ${detail}; the next subscribe heals it`,
      );
    }
  }
}
