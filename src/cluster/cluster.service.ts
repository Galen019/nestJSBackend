/**
 * Owns cluster-wide WebSocket client claims.
 *
 * - claims each client ID once with a short TTL, renewed by its owning session
 * - releases with compare-and-delete, so a stale close cannot free a new owner
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { withBoundedRetry } from '../common/retry';
import {
  quitRedisClient,
  type RedisLifecycleClient,
} from '../redis/redis.lifecycle';
import type { ClientId } from '../ws/session.interface';
import { CLAIM_TTL_SECONDS, CLUSTER_REDIS_CLIENT } from './cluster.constants';

/** Redis command surface used for claims. */
export interface ClusterCommandClient extends RedisLifecycleClient {
  /** Connects the client. */
  connect(): Promise<unknown>;
  /** Attaches an error listener. */
  on(event: 'error', listener: (err: Error) => void): unknown;
  /** Sets a key with NX/EX options. */
  set(
    key: string,
    value: string,
    options: { NX: boolean; EX: number },
  ): Promise<string | null>;
  /** Runs a compare-and-delete or compare-and-expire script. */
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

/** Deletes a claim only when its stored token still matches. */
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Extends a claim only when its stored token still matches. */
export const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

/** Bounded retry budget for the cluster connection. */
const CONNECT_RETRY = {
  attempts: 10,
  initialDelayMs: 50,
  maxDelayMs: 500,
} as const;

/** Redis key prefix for global client ownership claims. */
const CLAIM_PREFIX = 'ws:claim:';

/**
 * Builds the Redis key holding a client's owner.
 *
 * @param clientId Session key to claim.
 * @return The claim key.
 */
function claimKeyFor(clientId: ClientId): string {
  return `${CLAIM_PREFIX}${clientId}`;
}

/**
 * Coordinates client ownership across replicas.
 */
@Injectable()
export class ClusterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClusterService.name);

  /**
   * Creates the coordinator with its command client.
   *
   * @param client Redis command client for claims.
   */
  constructor(
    @Inject(CLUSTER_REDIS_CLIENT)
    private readonly client: ClusterCommandClient,
  ) {
    this.client.on('error', (err: Error) => {
      this.logger.error(`Cluster Redis client error: ${err.message}`);
    });
  }

  /**
   * Connects the command client on module init.
   *
   * @return Resolves when Redis is connected.
   */
  async onModuleInit(): Promise<void> {
    await withBoundedRetry(() => this.client.connect(), {
      ...CONNECT_RETRY,
      failureMessage:
        'Failed to connect cluster Redis client after 10 attempts',
    });
  }

  /**
   * Quits the command client on module destroy.
   *
   * @return Resolves when the connection is closed.
   */
  async onModuleDestroy(): Promise<void> {
    await quitRedisClient(this.client);
  }

  /**
   * Claims a client ID for this replica until the session releases it.
   *
   * @param clientId Session key to claim.
   * @return The claim token when the claim was won, otherwise undefined.
   */
  async claimClient(clientId: ClientId): Promise<string | undefined> {
    const claimToken = randomUUID();
    try {
      const reply = await this.client.set(claimKeyFor(clientId), claimToken, {
        NX: true,
        EX: CLAIM_TTL_SECONDS,
      });
      return reply === 'OK' ? claimToken : undefined;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`Failed to claim ${clientId}: ${detail}`);
      throw err instanceof Error ? err : new Error(detail);
    }
  }

  /**
   * Extends a claim while the caller still owns it.
   *
   * - returns false when the claim was lost, so the caller can end the session
   * - propagates Redis errors instead of hiding them
   *
   * @param clientId Session key to renew.
   * @param claimToken Token returned when the claim was won.
   * @return Whether this caller still owns a live claim.
   */
  async renewClient(clientId: ClientId, claimToken: string): Promise<boolean> {
    const reply: unknown = await this.client.eval(RENEW_SCRIPT, {
      keys: [claimKeyFor(clientId)],
      arguments: [claimToken, String(CLAIM_TTL_SECONDS)],
    });
    return reply === 1;
  }

  /**
   * Releases a claim only when the caller still owns it.
   *
   * @param clientId Session key to release.
   * @param claimToken Token returned when the claim was won.
   * @return Resolves when the compare-and-delete settles.
   */
  async releaseClient(clientId: ClientId, claimToken: string): Promise<void> {
    try {
      const reply: unknown = await this.client.eval(RELEASE_SCRIPT, {
        keys: [claimKeyFor(clientId)],
        arguments: [claimToken],
      });
      if (reply !== 0 && reply !== 1) {
        this.logger.warn(`Unexpected claim release result for ${clientId}`);
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`Failed to release ${clientId}: ${detail}`);
    }
  }
}
