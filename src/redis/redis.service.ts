import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { RedisClientType, SetOptions } from 'redis';
import { REDIS_CLIENT } from './redis.constants';

const MAX_CONNECT_ATTEMPTS = 10;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_SET_TTL_SECONDS = 3600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lifecycle wrapper around the injected `REDIS_CLIENT`.
 *
 * quits gracefully on module destroy when the client is open
 * exposes `ping()`/`isReady()` for health checks and readiness probes.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: RedisClientType,
  ) {
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });
  }

  /**
   * Connects to Redis on module init with bounded exponential-backoff retries.
   *
   * - attempts `client.connect()` up to MAX_CONNECT_ATTEMPTS times
   * - waits with exponential delay capped at MAX_RETRY_DELAY_MS between attempts
   * - throws the last error when all attempts fail.
   */
  async onModuleInit(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.client.connect();
        return;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_CONNECT_ATTEMPTS) {
          await sleep(
            Math.min(
              INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
              MAX_RETRY_DELAY_MS,
            ),
          );
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Failed to connect to Redis after ${MAX_CONNECT_ATTEMPTS} attempts`,
        );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  /**
   * Creates a key:value entry in Redis, forwarding full set options.
   *
   * - validates the key is a non-empty string before calling Redis
   * - applies a default 1-hour EX expiration when `options.expiration` is absent
   * - delegates to `client.set`, passing `options` through verbatim when given
   * - resolves with 'OK' (or prior value when `GET` is set, null when NX/XX skips)
   * - rejects with the client error when Redis fails.
   *
   * @param key Redis key to create.
   * @param value String value to store.
   * @param options Full set options (expiration, condition, GET).
   * @return The Redis SET reply.
   */
  async set(
    key: string,
    value: string,
    options?: SetOptions,
  ): Promise<string | null> {
    this.assertValidKey(key);
    if (options?.expiration === undefined) {
      return this.client.set(key, value, {
        ...options,
        expiration: { type: 'EX', value: DEFAULT_SET_TTL_SECONDS },
      });
    }
    return this.client.set(key, value, options);
  }

  /**
   * Reads a value back from Redis by key.
   *
   * - validates the key is a non-empty string before calling Redis
   * - delegates to `client.get`
   * - resolves with the stored string, or null on a cache miss
   * - rejects with the client error when Redis fails.
   *
   * @param key Redis key to read.
   * @return The stored value, or null when the key does not exist.
   */
  async get(key: string): Promise<string | null> {
    this.assertValidKey(key);
    return this.client.get(key);
  }

  /**
   * Rejects empty or whitespace-only keys before Redis is called.
   *
   * - throws when `key` is not a non-empty string
   * - otherwise returns without effect.
   *
   * @param key Candidate Redis key.
   */
  private assertValidKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Redis key must be a non-empty string');
    }
  }

  isReady(): boolean {
    return this.client.isReady;
  }
}
