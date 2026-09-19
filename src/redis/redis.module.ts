import { Module } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { REDIS_CLIENT, getRedisConfig } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Redis DI module.
 *
 * - Provides REDIS_CLIENT via factory from REDIS_* env
 * - Registers/exports RedisService
 * - Socket: host/port, capped reconnect, password, no offline queue
 */
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): RedisClientType => {
        const config = getRedisConfig();
        return createClient({
          socket: {
            host: config.host,
            port: config.port,
            reconnectStrategy: (retries: number): number =>
              Math.min(retries * 100, 5000),
          },
          password: config.password,
          disableOfflineQueue: true,
        });
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
