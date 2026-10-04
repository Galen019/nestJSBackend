/**
 * Lifecycle wrapper around the injected Redis client.
 *
 * - connects on module init via the shared bounded-retry helper
 * - exposes `ping()`/`isReady()` plus key CRUD for health checks and routes.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { RedisClientType, SetOptions } from 'redis';
import {
  attachRedisErrorHandler,
  connectRedisClient,
  quitRedisClient,
} from './redis.lifecycle';
import { REDIS_CLIENT } from './redis.constants';

export interface RedisEntry {
  value: string;
  expiresIn: number | null;
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

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClientType) {
    attachRedisErrorHandler(this.client, (err: Error) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });
  }

  /**
   * Connects to Redis on module init with bounded exponential-backoff retries.
   *
   * - delegates to the shared lifecycle helper, throws when attempts fail.
   */
  async onModuleInit(): Promise<void> {
    await connectRedisClient(
      this.client,
      'Failed to connect to Redis after 10 attempts',
    );
  }

  /**
   * Quits the Redis client gracefully on module destroy when open.
   */
  async onModuleDestroy(): Promise<void> {
    await quitRedisClient(this.client);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  /**
   * Creates a key:value entry in Redis, forwarding set options verbatim.
   *
   * - validates the key is a non-empty string before calling Redis
   * - passes `options` through untouched, including undefined
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
   * Reads a value with its TTL by key in one logical read.
   *
   * - validates the key once before calling Redis
   * - resolves null on a cache miss without checking TTL
   * - maps TTL -2 (expired between calls) to null as a miss
   * - maps TTL -1 (persistent) to null expiry, otherwise remaining seconds
   * - rejects with the client error when Redis fails.
   *
   * @param key Redis key to read.
   * @return The stored value with expiry, or null when the key does not exist.
   */
  async getEntry(key: string): Promise<RedisEntry | null> {
    this.assertValidKey(key);
    const value = await this.client.get(key);
    if (value === null) {
      return null;
    }
    const ttl = await this.client.ttl(key);
    if (ttl === -2) {
      return null;
    }
    if (ttl === -1) {
      return { value, expiresIn: null };
    }
    return { value, expiresIn: ttl };
  }

  /**
   * Rejects empty or whitespace-only keys before Redis is called.
   *
   * - internal invariant guard, request shape is owned by DTOs + global pipe
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
