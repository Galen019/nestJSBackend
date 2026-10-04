import { Module } from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT, createRedisClient } from './redis.constants';
import { RedisController } from './redis.controller';
import { RedisService } from './redis.service';

/**
 * Redis DI module.
 *
 * - Provides REDIS_CLIENT via factory from REDIS_* env
 * - Registers/exports RedisService
 * - Socket: host/port, capped reconnect, password, no offline queue
 */
@Module({
  controllers: [RedisController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): RedisClientType => createRedisClient(),
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
