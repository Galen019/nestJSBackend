/** DI tokens and claim tuning for cluster-wide WebSocket coordination. */
import { createRedisClient } from '../redis/redis.constants';

/** DI token for the Redis command client used by cluster coordination. */
export const CLUSTER_REDIS_CLIENT = 'CLUSTER_REDIS_CLIENT';

/** Lifetime of one client claim, extended by the owning session. */
export const CLAIM_TTL_SECONDS = 30;

/** Interval at which an owning session extends its claim. */
export const CLAIM_RENEW_INTERVAL_MS = 10_000;

/**
 * Creates an unconnected command client with the shared Redis settings.
 *
 * @return An unconnected Redis client for claims.
 */
export function createClusterRedisClient(): ReturnType<
  typeof createRedisClient
> {
  return createRedisClient();
}
