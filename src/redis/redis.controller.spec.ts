/**
 * Test suite for RedisController with mocked RedisService.
 *
 * - GET /redis: hit resolves key/value, miss throws 404, errors propagate
 * - blank-key 400s are owned by GetRedisDto + global pipe, covered by e2e
 * - POST /redis: applies edge default TTL, maps expiration and condition
 * - conflicts are unrepresentable in the DTO so no conflict branches exist
 * - service rejections propagate without mapping
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { SetOptions } from 'redis';
import { RedisController } from './redis.controller';
import { DEFAULT_SET_TTL_SECONDS } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Creates a fresh mocked RedisService for controller DI.
 *
 * - stubs `get` to resolve null by default (cache miss)
 * - stubs `set` to resolve 'OK' by default.
 */
function createServiceFake() {
  return {
    get: vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
    set: vi
      .fn<
        (
          key: string,
          value: string,
          options?: SetOptions,
        ) => Promise<string | null>
      >()
      .mockResolvedValue('OK'),
  };
}

type ServiceFake = ReturnType<typeof createServiceFake>;

describe('RedisController', () => {
  let controller: RedisController;
  let service: ServiceFake;

  /**
   * Builds a testing module with the mocked RedisService.
   *
   * - provides current `service` fake as RedisService value
   * - resolves the controller under test.
   */
  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      controllers: [RedisController],
      providers: [
        {
          provide: RedisService,
          useValue: service,
        },
      ],
    }).compile();
  }

  beforeEach(async () => {
    service = createServiceFake();
    const module = await compile();
    controller = module.get<RedisController>(RedisController);
  });

  describe('getValue', () => {
    it('resolves key and value on a cache hit', async () => {
      service.get.mockResolvedValueOnce('value');

      await expect(controller.getValue({ key: 'key' })).resolves.toEqual({
        key: 'key',
        value: 'value',
      });
      expect(service.get).toHaveBeenCalledWith('key');
    });

    it('throws 404 on a cache miss', async () => {
      await expect(controller.getValue({ key: 'missing' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('propagates service errors', async () => {
      service.get.mockRejectedValueOnce(new Error('READONLY'));

      await expect(controller.getValue({ key: 'key' })).rejects.toThrow(
        'READONLY',
      );
    });
  });

  describe('setValue', () => {
    it('applies the edge default TTL without options', async () => {
      await expect(
        controller.setValue({ key: 'key', value: 'value' }),
      ).resolves.toEqual({ key: 'key', value: 'value', result: 'OK' });
      expect(service.set).toHaveBeenCalledWith('key', 'value', {
        expiration: { type: 'EX', value: DEFAULT_SET_TTL_SECONDS },
      });
    });

    it('treats an empty options object as absent with default TTL', async () => {
      await controller.setValue({ key: 'key', value: 'value', options: {} });

      expect(service.set).toHaveBeenCalledWith('key', 'value', {
        expiration: { type: 'EX', value: DEFAULT_SET_TTL_SECONDS },
      });
    });

    it('maps EX expiration and NX condition to client options', async () => {
      await controller.setValue({
        key: 'key',
        value: 'value',
        options: { expiration: { type: 'EX', value: 60 }, condition: 'NX' },
      });

      expect(service.set).toHaveBeenCalledWith('key', 'value', {
        expiration: { type: 'EX', value: 60 },
        condition: 'NX',
      });
    });

    it('maps PX expiration to client options', async () => {
      await controller.setValue({
        key: 'key',
        value: 'value',
        options: { expiration: { type: 'PX', value: 5000 } },
      });

      expect(service.set).toHaveBeenCalledWith('key', 'value', {
        expiration: { type: 'PX', value: 5000 },
      });
    });

    it('maps XX condition with default TTL to client options', async () => {
      await controller.setValue({
        key: 'key',
        value: 'value',
        options: { condition: 'XX' },
      });

      expect(service.set).toHaveBeenCalledWith('key', 'value', {
        expiration: { type: 'EX', value: DEFAULT_SET_TTL_SECONDS },
        condition: 'XX',
      });
    });

    it('propagates service errors', async () => {
      service.set.mockRejectedValueOnce(new Error('READONLY'));

      await expect(
        controller.setValue({ key: 'key', value: 'value' }),
      ).rejects.toThrow('READONLY');
    });
  });
});
