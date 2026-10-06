/**
 * Provides per-user Redis subscriptions with a dedicated subscriber client.
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
