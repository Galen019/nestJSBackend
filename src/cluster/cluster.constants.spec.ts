/** Unit suite for cluster DI tokens and claim tuning. */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_RENEW_INTERVAL_MS,
  CLAIM_TTL_SECONDS,
  CLUSTER_REDIS_CLIENT,
  createClusterRedisClient,
} from './cluster.constants';

describe('cluster constants', () => {
  it('exposes the command token and a renewal interval inside the claim TTL', () => {
    expect(CLUSTER_REDIS_CLIENT).toBe('CLUSTER_REDIS_CLIENT');
    expect(CLAIM_TTL_SECONDS).toBeGreaterThan(CLAIM_RENEW_INTERVAL_MS / 1000);
  });

  it('creates an unconnected Redis client with a connect method', () => {
    const client = createClusterRedisClient();

    expect(typeof client.connect).toBe('function');
    expect(client.isOpen).toBe(false);
  });
});
