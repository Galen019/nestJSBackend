/**
 * Readiness probe for Redis and DynamoDB dependencies.
 *
 * - GET /health stays `@Public()`; all other routes require a Bearer token
 * - probes both dependencies in parallel and reports per-dependency status.
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { DynamoService } from '../dynamo/dynamo.service';
import { RedisService } from '../redis/redis.service';

/**
 * Per-dependency readiness state.
 */
export type DependencyStatus = 'up' | 'down';

/**
 * Overall readiness state: `ok` when every dependency is up.
 */
export type HealthStatus = 'ok' | 'degraded';

/**
 * Readiness response body for success and 503 payloads.
 */
export interface HealthResponse {
  status: HealthStatus;
  redis: DependencyStatus;
  dynamo: DependencyStatus;
}

/**
 * Readiness probe for Redis and DynamoDB dependencies.
 *
 * - GET /health: pings Redis and DynamoDB
 * - Success: `{ status: 'ok', redis: 'up', dynamo: 'up' }`
 * - Failure: throws 503 `{ status: 'degraded', redis, dynamo }`
 */
@Controller('health')
export class HealthController {
  /**
   * Creates the controller with dependency services.
   *
   * @param redisService Redis readiness probe.
   * @param dynamoService DynamoDB readiness probe.
   */
  constructor(
    private readonly redisService: RedisService,
    private readonly dynamoService: DynamoService,
  ) {}

  /**
   * Checks Redis and DynamoDB readiness.
   *
   * - probes both dependencies concurrently so one slow dep never blocks the other
   * - maps each settlement to `up`/`down` without short-circuiting
   * - throws 503 with per-dependency status when any probe fails.
   *
   * @return Ok status when both are up.
   */
  @Get()
  @Public()
  async check(): Promise<HealthResponse> {
    const [redisResult, dynamoResult] = await Promise.allSettled([
      this.redisService.ping(),
      this.dynamoService.ping(),
    ]);
    const redis: DependencyStatus =
      redisResult.status === 'fulfilled' ? 'up' : 'down';
    const dynamo: DependencyStatus =
      dynamoResult.status === 'fulfilled' ? 'up' : 'down';
    if (redis !== 'up' || dynamo !== 'up') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        redis,
        dynamo,
      });
    }
    return { status: 'ok', redis, dynamo };
  }
}
