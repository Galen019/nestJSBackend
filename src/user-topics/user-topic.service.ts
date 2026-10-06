/**
 * Per-user Redis SUBSCRIBE lifecycle for distributed WS fan-out.
 *
 * - implements `SessionTracker`: subscribes `user:{userId}` while the user
 *   holds local sessions, unsubscribes when the last one disconnects
 * - owns one dedicated subscriber connection plus the set of claimed channels
 * - keeps no connection counts: `WsService` owns the per-user totals and
 *   reports them per event, this service only tracks what it subscribed
 * - one `withTopicOp` path runs every (un)subscribe with the same bounded
 *   retry budget; `WsService` additionally isolates tracker failures, so an
 *   unexpected throw still cannot stall siblings
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
import { quitRedisClient } from '../redis/redis.lifecycle';
import type {
  SessionLifecycleEvent,
  SessionTracker,
  UserId,
} from '../ws/session.interface';
import type { SubscriberClient } from './subscriber-client';

/** DI token for the dedicated pub/sub subscriber connection. */
export const USER_TOPIC_SUBSCRIBER = 'USER_TOPIC_SUBSCRIBER';

/**
 * Retry budget shared by every topic (un)subscribe.
 *
 * - deliberately smaller and faster than the boot-time connect budget: a
 *   topic op that exhausts it heals on the next lifecycle event, while a
 *   boot connect has no later trigger and must keep retrying.
 */
const TOPIC_RETRY = {
  attempts: 5,
  initialDelayMs: 50,
  maxDelayMs: 500,
} as const;

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
   * Runs one topic (un)subscribe with the shared bounded retry budget.
   *
   * - single owner of topic retry policy, one path for both operations
   * - releases a subscribe claim when the budget is exhausted so the next
   *   connect retries instead of leaving the channel silently unsubscribed;
   *   an unsubscribe claim is already released, so a failed unsubscribe
   *   heals on the next subscribe, which re-subscribes idempotently
   * - logs and swallows failures so fan-out callers resolve.
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
}
