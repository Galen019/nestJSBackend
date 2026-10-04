/**
 * User-topics feature module.
 *
 * - Provides the dedicated `USER_TOPIC_SUBSCRIBER` connection plus
 *   `UserTopicService` for per-user Redis subscriptions
 * - The subscriber stays separate from the command `REDIS_CLIENT` because a
 *   subscribed connection cannot run regular commands
 * - Imported by `WsModule`; the future publisher imports it too for
 *   `channelFor` and topic writes.
 */
import { Module } from '@nestjs/common';
import { createRedisClient } from '../redis/redis.constants';
import type { SubscriberClient } from './subscriber-client';
import { USER_TOPIC_SUBSCRIBER, UserTopicService } from './user-topic.service';

@Module({
  providers: [
    {
      provide: USER_TOPIC_SUBSCRIBER,
      useFactory: (): SubscriberClient => createRedisClient(),
    },
    UserTopicService,
  ],
  exports: [UserTopicService],
})
export class UserTopicsModule {}
