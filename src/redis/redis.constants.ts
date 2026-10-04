/**
 * Redis DI token, env config, and client factory.
 *
 * - REDIS_CLIENT: injection token
 * - getRedisConfig: reads REDIS_HOST/PORT/PASSWORD
 * - createRedisClient: single owner of the client-construction policy,
 *   shared by the command client and subscriber-only connections.
 */
import { createClient, type RedisClientType } from 'redis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Default TTL applied at the HTTP edge when POST /redis omits expiration.
 */
export const DEFAULT_SET_TTL_SECONDS = 3600;

export interface RedisConfig {
  host: string;
  port: number;
  password: string | undefined;
}

const DEFAULT_REDIS_HOST = 'localhost';
const DEFAULT_REDIS_PORT = 6379;
const MAX_REDIS_PORT = 65535;

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_REDIS_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REDIS_PORT) {
    throw new Error(`Invalid REDIS_PORT: ${raw}`);
  }
  return parsed;
}

export function getRedisConfig(): RedisConfig {
  const password = process.env.REDIS_PASSWORD;
  return {
    host: process.env.REDIS_HOST ?? DEFAULT_REDIS_HOST,
    port: parsePort(process.env.REDIS_PORT),
    password: password === undefined || password === '' ? undefined : password,
  };
}

/**
 * Creates a Redis client from the shared env config.
 *
 * - single owner of the construction policy (socket, capped reconnect, auth,
 *   no offline queue) for every connection in the process
 * - returns an unconnected client; callers connect via the lifecycle helpers
 * - subscriber-only connections use this too but stay separate clients,
 *   because a subscribed connection cannot run regular commands.
 *
 * @return An unconnected Redis client.
 */
export function createRedisClient(): RedisClientType {
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
}
