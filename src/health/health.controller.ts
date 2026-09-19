import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

interface HealthResponse {
  status: string;
  redis: string;
}

/**
 * Readiness probe for Redis dependency.
 *
 * - GET /health: pings Redis via RedisService
 * - Success: `{ status: 'ok', redis: 'up' }`
 * - Failure: throws 503 `{ status: 'degraded', redis: 'down' }`
 */
@Controller('health')
export class HealthController {
  constructor(private readonly redisService: RedisService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    try {
      await this.redisService.ping();
      return { status: 'ok', redis: 'up' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded',
        redis: 'down',
      });
    }
  }
}
