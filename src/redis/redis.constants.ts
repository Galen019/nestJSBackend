/** Redis injection token, configuration, and shared client factory. */
import { createClient, type RedisClientType } from 'redis';
import { parseBoundedInt } from '../common/env';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Default TTL for POST /redis when expiration is omitted. */
export const DEFAULT_SET_TTL_SECONDS = 3600;

export interface RedisConfig {
  host: string;
  port: number;
  password: string | undefined;
}

const DEFAULT_REDIS_HOST = 'localhost';
const DEFAULT_REDIS_PORT = 6379;
const MAX_REDIS_PORT = 65535;

/**
 * Validates the configured Redis port.
 *
 * @param raw Raw `REDIS_PORT` value.
 * @return Validated port number.
 */
function parsePort(raw: string | undefined): number {
  return parseBoundedInt(raw, {
    defaultValue: DEFAULT_REDIS_PORT,
    min: 1,
    max: MAX_REDIS_PORT,
    label: 'REDIS_PORT',
  });
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
 * Creates an unconnected client using shared Redis settings.
 * Subscriber connections use separate clients from command connections.
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
