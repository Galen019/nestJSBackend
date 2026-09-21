import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RedisClientType, SetOptions } from 'redis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Test suite for RedisService with mocked Redis client.
 *
 * - onModuleInit: error listener, connect, retry, exhaust
 * - ping: delegates to client
 * - set: delegates key/value/options, validates key, propagates errors
 * - get: delegates key, validates key, resolves value or null
 * - getEntry: single read with TTL, maps -1/-2, validates once
 * - onModuleDestroy: quit if open, skip if closed
 */

/**
 * Creates a fresh mocked Redis client for DI.
 *
 * - defaults `isOpen`/`isReady` to false
 * - stubs `connect`/`quit`/`ping`/`set`/`get`/`ttl`/`on` with vitest mocks.
 */
function createClientFake() {
  return {
    isOpen: false,
    isReady: false,
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
    ping: vi.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    set: vi
      .fn<
        (
          key: string,
          value: string,
          options?: SetOptions,
        ) => Promise<string | null>
      >()
      .mockResolvedValue('OK'),
    get: vi
      .fn<(key: string) => Promise<string | null>>()
      .mockResolvedValue(null),
    ttl: vi.fn<(key: string) => Promise<number>>().mockResolvedValue(60),
    on: vi.fn<() => unknown>().mockReturnValue(undefined),
  };
}

type ClientFake = ReturnType<typeof createClientFake>;

describe('RedisService', () => {
  let service: RedisService;
  let client: ClientFake;

  /**
   * Builds a testing module with the mocked REDIS_CLIENT.
   *
   * - provides current `client` fake as REDIS_CLIENT value
   * - returns compiled TestingModule for service resolution.
   */
  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: client as unknown as RedisClientType,
        },
      ],
    }).compile();
  }

  beforeEach(() => {
    client = createClientFake();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('subscribes to client errors so socket failures do not crash the process', async () => {
      const module = await compile();

      expect(client.on).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
      await module.close();
    });

    it('connects on startup without retry', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await service.onModuleInit();

      expect(client.connect).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('retries failed attempts then connects', async () => {
      vi.useFakeTimers();
      client.connect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(undefined);
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      const init = service.onModuleInit();
      await vi.runAllTimersAsync();
      await init;

      expect(client.connect).toHaveBeenCalledTimes(3);
      await module.close();
    });

    it('throws after exhausting retries', async () => {
      vi.useFakeTimers();
      client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      const init = service.onModuleInit();
      const assertion = expect(init).rejects.toThrow('ECONNREFUSED');
      await vi.runAllTimersAsync();
      await assertion;

      expect(client.connect).toHaveBeenCalledTimes(10);
      await module.close();
    });
  });

  describe('ping', () => {
    it('returns PONG', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.ping()).resolves.toBe('PONG');
      await module.close();
    });
  });

  describe('set', () => {
    it('delegates key and value verbatim without options', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.set('key', 'value')).resolves.toBe('OK');

      // verbatim passthrough, edge default TTL lives in the controller
      expect(client.set).toHaveBeenCalledWith('key', 'value', undefined);

      await module.close();
    });

    it('forwards full set options verbatim', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);
      const options: SetOptions = {
        expiration: { type: 'EX', value: 60 },
        condition: 'NX',
      };

      await service.set('key', 'value', options);

      expect(client.set).toHaveBeenCalledWith('key', 'value', options);
      await module.close();
    });

    it('rejects empty keys without calling the client', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.set('   ', 'value')).rejects.toThrow();
      expect(client.set).not.toHaveBeenCalled();
      await module.close();
    });

    it('propagates client errors', async () => {
      client.set.mockRejectedValueOnce(new Error('READONLY'));
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.set('key', 'value')).rejects.toThrow('READONLY');
      await module.close();
    });
  });

  describe('get', () => {
    it('delegates key and resolves the stored value', async () => {
      client.get.mockResolvedValueOnce('value');
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.get('key')).resolves.toBe('value');
      expect(client.get).toHaveBeenCalledWith('key');
      await module.close();
    });

    it('resolves null on a cache miss', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.get('missing')).resolves.toBeNull();
      await module.close();
    });

    it('rejects empty keys without calling the client', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.get('')).rejects.toThrow();
      expect(client.get).not.toHaveBeenCalled();
      await module.close();
    });
  });

  describe('getEntry', () => {
    it('resolves value with TTL seconds on a hit', async () => {
      client.get.mockResolvedValueOnce('value');
      client.ttl.mockResolvedValueOnce(42);
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('key')).resolves.toEqual({
        value: 'value',
        expiresIn: 42,
      });
      expect(client.get).toHaveBeenCalledWith('key');
      expect(client.ttl).toHaveBeenCalledWith('key');
      await module.close();
    });

    it('resolves null expiry for persistent keys', async () => {
      client.get.mockResolvedValueOnce('value');
      client.ttl.mockResolvedValueOnce(-1);
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('key')).resolves.toEqual({
        value: 'value',
        expiresIn: null,
      });
      await module.close();
    });

    it('resolves null when the key expires between get and ttl', async () => {
      client.get.mockResolvedValueOnce('value');
      client.ttl.mockResolvedValueOnce(-2);
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('key')).resolves.toBeNull();
      await module.close();
    });

    it('resolves null on a miss without checking TTL', async () => {
      client.get.mockResolvedValueOnce(null);
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('missing')).resolves.toBeNull();
      expect(client.ttl).not.toHaveBeenCalled();
      await module.close();
    });

    it('rejects empty keys without calling the client', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('   ')).rejects.toThrow();
      expect(client.get).not.toHaveBeenCalled();
      expect(client.ttl).not.toHaveBeenCalled();
      await module.close();
    });

    it('propagates get errors without checking TTL', async () => {
      client.get.mockRejectedValueOnce(new Error('READONLY'));
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('key')).rejects.toThrow('READONLY');
      expect(client.ttl).not.toHaveBeenCalled();
      await module.close();
    });

    it('propagates TTL errors', async () => {
      client.get.mockResolvedValueOnce('value');
      client.ttl.mockRejectedValueOnce(new Error('READONLY'));
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await expect(service.getEntry('key')).rejects.toThrow('READONLY');
      await module.close();
    });
  });

  describe('onModuleDestroy', () => {
    it('quits when the client is open', async () => {
      client.isOpen = true;
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await service.onModuleDestroy();

      expect(client.quit).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('skips quit when the client is closed', async () => {
      const module = await compile();
      service = module.get<RedisService>(RedisService);

      await service.onModuleDestroy();

      expect(client.quit).not.toHaveBeenCalled();
      await module.close();
    });
  });
});
