/**
 * HealthController unit suite with mocked RedisService and DynamoService.
 *
 * - check: ok/up on both pings resolve, 503 when either rejects
 * - DynamoDB stub comes from the shared `createDynamoFake` helper.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamoService } from '../dynamo/dynamo.service';
import { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';
import {
  createDynamoFake,
  type DynamoFake,
} from '../../test/dynamo-test.helper';

describe('HealthController', () => {
  let controller: HealthController;
  let redisPing: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let dynamoFake: DynamoFake;

  beforeEach(async () => {
    redisPing = vi.fn<() => Promise<string>>().mockResolvedValue('PONG');
    dynamoFake = createDynamoFake();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: RedisService, useValue: { ping: redisPing } },
        { provide: DynamoService, useValue: dynamoFake },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('check', () => {
    it('returns ok/up when Redis and DynamoDB answer', async () => {
      await expect(controller.check()).resolves.toEqual({
        status: 'ok',
        redis: 'up',
        dynamo: 'up',
      });
    });

    it('throws 503 when Redis is down', async () => {
      redisPing.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(controller.check()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws 503 when DynamoDB is down', async () => {
      dynamoFake.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(controller.check()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('reports which dependency is down', async () => {
      dynamoFake.ping.mockRejectedValueOnce(new Error('Unreachable'));

      const caught: unknown = await controller
        .check()
        .catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      const response = (caught as ServiceUnavailableException).getResponse();
      expect(response).toEqual({
        status: 'degraded',
        redis: 'up',
        dynamo: 'down',
      });
    });
  });
});
