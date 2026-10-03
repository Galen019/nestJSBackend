/**
 * Test suite for DynamoService with a mocked DynamoDB client.
 *
 * - onModuleInit: connects without retry, retries then connects, exhausts
 * - ping: delegates to ListTables, propagates errors
 * - onModuleDestroy: destroys the client
 * - getClient: returns the injected client
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DYNAMO_CLIENT } from './dynamo.constants';
import { DynamoService } from './dynamo.service';

/**
 * Creates a fresh mocked DynamoDB client for DI.
 *
 * - stubs `send` to resolve and `destroy` to no-op by default.
 */
function createClientFake() {
  return {
    send: vi.fn<() => Promise<unknown>>().mockResolvedValue({ TableNames: [] }),
    destroy: vi.fn<() => unknown>().mockReturnValue(undefined),
  };
}

type ClientFake = ReturnType<typeof createClientFake>;

describe('DynamoService', () => {
  let service: DynamoService;
  let client: ClientFake;

  /**
   * Builds a testing module with the mocked DYNAMO_CLIENT.
   *
   * - provides current `client` fake as DYNAMO_CLIENT value
   * - returns compiled TestingModule for service resolution.
   */
  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        DynamoService,
        {
          provide: DYNAMO_CLIENT,
          useValue: client as unknown as DynamoDBClient,
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
    it('connects on startup without retry', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      expect(client.send).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('retries failed attempts then connects', async () => {
      vi.useFakeTimers();
      client.send
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ TableNames: [] });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      const init = service.onModuleInit();
      await vi.runAllTimersAsync();
      await init;

      expect(client.send).toHaveBeenCalledTimes(3);
      await module.close();
    });

    it('throws after exhausting retries', async () => {
      vi.useFakeTimers();
      client.send.mockRejectedValue(new Error('ECONNREFUSED'));
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      const init = service.onModuleInit();
      const assertion = expect(init).rejects.toThrow('ECONNREFUSED');
      await vi.runAllTimersAsync();
      await assertion;

      expect(client.send).toHaveBeenCalledTimes(10);
      await module.close();
    });
  });

  describe('ping', () => {
    it('resolves when DynamoDB answers', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await expect(service.ping()).resolves.toBeUndefined();
      expect(client.send).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('propagates client errors', async () => {
      client.send.mockRejectedValueOnce(new Error('Unreachable'));
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await expect(service.ping()).rejects.toThrow('Unreachable');
      await module.close();
    });
  });

  describe('onModuleDestroy', () => {
    it('destroys the client', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleDestroy();

      expect(client.destroy).toHaveBeenCalledTimes(1);
      await module.close();
    });
  });

  describe('getClient', () => {
    it('returns the injected client', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      expect(service.getClient()).toBe(client as unknown as DynamoDBClient);
      await module.close();
    });
  });
});
