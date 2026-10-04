/**
 * Unit suite for Redis env config plus the shared client factory.
 *
 * - config: defaults, env mapping, empty password, invalid ports throw
 * - factory: maps host/port/password, disables the offline queue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRedisClient, getRedisConfig } from './redis.constants';

describe('getRedisConfig', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('defaults to localhost:6379 with no password', () => {
    expect(getRedisConfig()).toEqual({
      host: 'localhost',
      port: 6379,
      password: undefined,
    });
  });

  it('maps host, port, and password from the environment', () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';

    expect(getRedisConfig()).toEqual({
      host: 'redis',
      port: 6380,
      password: 'secret',
    });
  });

  it('treats an empty password as unset', () => {
    process.env.REDIS_PASSWORD = '';

    expect(getRedisConfig().password).toBeUndefined();
  });

  it('throws on non-integer or out-of-range ports', () => {
    for (const port of ['abc', '0', '65536', '1.5']) {
      process.env.REDIS_PORT = port;

      expect(() => getRedisConfig()).toThrow(/REDIS_PORT/);
    }
  });
});

describe('createRedisClient', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('builds an unconnected client from the env config', () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';
    const client = createRedisClient();
    const socket = client.options?.socket;

    expect(client.isOpen).toBe(false);
    expect(socket !== undefined && 'host' in socket && socket.host).toBe(
      'redis',
    );
    expect(socket !== undefined && 'port' in socket && socket.port).toBe(6380);
    expect(client.options?.password).toBe('secret');
    expect(client.options?.disableOfflineQueue).toBe(true);
  });
});
