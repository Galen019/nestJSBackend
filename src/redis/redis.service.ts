import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT } from './redis.constants';

const MAX_CONNECT_ATTEMPTS = 10;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lifecycle wrapper around the injected `REDIS_CLIENT`.
 *
 * connects on module init with bounded exponential-backoff retries
 * logs client `error` events without crashing
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

  isReady(): boolean {
    return this.client.isReady;
  }
}
