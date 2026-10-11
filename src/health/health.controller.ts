/**
 * Liveness and readiness probes for Kubernetes.
 *
 * - LiveController has no dependencies so liveness never touches Redis or DynamoDB
 * - ReadyController probes both dependencies in parallel and reports per-dependency status
 * - Probe paths come from the shared health constants.
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { DynamoService } from '../dynamo/dynamo.service';
import { RedisService } from '../redis/redis.service';
import {
  HEALTH_BASE_PATH,
  LIVE_SUBPATH,
  READY_SUBPATH,
} from './health.constants';

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
export interface ReadyResponse {
  status: HealthStatus;
  redis: DependencyStatus;
  dynamo: DependencyStatus;
}

/**
 * Liveness response body sharing the readiness ok status.
 */
export interface LiveResponse {
  status: 'ok';
}

/**
 * Process liveness probe without dependencies.
 *
 * - GET /health/live answers when the process is alive.
 */
@Controller(HEALTH_BASE_PATH)
export class LiveController {
  /**
   * Reports process liveness without touching dependencies.
   *
   * @return Ok status when the process answers.
   */
  @Get(LIVE_SUBPATH)
  @Public()
  live(): LiveResponse {
    return { status: 'ok' };
  }
}

/**
 * Dependency readiness probe for Redis and DynamoDB.
 *
 * - GET /health/ready pings Redis and DynamoDB
 * - Success: `{ status: 'ok', redis: 'up', dynamo: 'up' }`
 * - Failure: throws 503 `{ status: 'degraded', redis, dynamo }`.
 */
@Controller(HEALTH_BASE_PATH)
export class ReadyController {
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
  @Get(READY_SUBPATH)
  @Public()
  async ready(): Promise<ReadyResponse> {
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
