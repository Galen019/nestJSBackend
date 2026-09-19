/**
 * Redis DI token and env config.
 *
 * - REDIS_CLIENT: injection token
 * - getRedisConfig: reads REDIS_HOST/PORT/PASSWORD
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

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
