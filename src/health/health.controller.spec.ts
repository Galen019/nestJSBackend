import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';

/**
 * HealthController.check() with mocked RedisService.
 *
 * - check: ok/up on ping resolve, 503 on ping reject
 */
describe('HealthController', () => {
  let controller: HealthController;
  let ping: ReturnType<typeof vi.fn<() => Promise<string>>>;

  beforeEach(async () => {
    ping = vi.fn<() => Promise<string>>().mockResolvedValue('PONG');
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: RedisService, useValue: { ping } }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('check', () => {
    it('returns ok/up when Redis answers', async () => {
      await expect(controller.check()).resolves.toEqual({
        status: 'ok',
        redis: 'up',
      });
    });

    it('throws 503 when Redis is down', async () => {
      ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(controller.check()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
