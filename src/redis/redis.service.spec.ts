import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Test suite for RedisService with mocked Redis client.
 *
 * - onModuleInit: error listener, connect, retry, exhaust
 * - ping: delegates to client
 * - onModuleDestroy: quit if open, skip if closed
 */

/**
 * Creates a fresh mocked Redis client for DI.
 *
 * - defaults `isOpen`/`isReady` to false
 * - stubs `connect`/`quit`/`ping`/`on` with vitest mocks.
 */
function createClientFake() {
  return {
    isOpen: false,
    isReady: false,
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
    ping: vi.fn<() => Promise<string>>().mockResolvedValue('PONG'),
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
