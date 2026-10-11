/**
 * Health probe unit suite with a dependency-free liveness controller.
 *
 * - live: always ok with no providers wired
 * - ready: ok/up on both pings resolve, 503 when either rejects
 * - DynamoDB stub comes from the shared `createDynamoFake` helper.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamoService } from '../dynamo/dynamo.service';
import { RedisService } from '../redis/redis.service';
import { LiveController, ReadyController } from './health.controller';
import {
  createDynamoFake,
  type DynamoFake,
} from '../../test/dynamo-test.helper';

describe('LiveController', () => {
  let controller: LiveController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LiveController],
    }).compile();

    controller = module.get<LiveController>(LiveController);
  });

  it('returns ok without dependencies', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });
});

describe('ReadyController', () => {
  let controller: ReadyController;
  let redisPing: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let dynamoFake: DynamoFake;

  beforeEach(async () => {
    redisPing = vi.fn<() => Promise<string>>().mockResolvedValue('PONG');
    dynamoFake = createDynamoFake();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReadyController],
      providers: [
        { provide: RedisService, useValue: { ping: redisPing } },
        { provide: DynamoService, useValue: dynamoFake },
      ],
    }).compile();

    controller = module.get<ReadyController>(ReadyController);
  });

  it('returns ok/up when Redis and DynamoDB answer', async () => {
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      redis: 'up',
      dynamo: 'up',
    });
  });

  it('throws 503 when Redis is down', async () => {
    redisPing.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(controller.ready()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws 503 when DynamoDB is down', async () => {
    dynamoFake.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(controller.ready()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('reports which dependency is down', async () => {
    dynamoFake.ping.mockRejectedValueOnce(new Error('Unreachable'));

    const caught: unknown = await controller
      .ready()
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
