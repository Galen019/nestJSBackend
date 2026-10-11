/**
 * Shared e2e bootstrap with mocked RedisService/DynamoService/subscriber.
 *
 * - mirrors main.ts setup (global pipe, ws adapter) like app.e2e-spec.ts
 * - points JWT config at the committed test keypair before compile
 * - disables the metrics scrape server so suites never bind a real port.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { SetOptions } from 'redis';
import { AppModule } from './../src/app.module';
import { createGlobalValidationPipe } from './../src/app.pipes';
import { DynamoService } from './../src/dynamo/dynamo.service';
import { RedisService, type RedisEntry } from './../src/redis/redis.service';
import { USER_TOPIC_SUBSCRIBER } from './../src/user-topics/user-topic.service';
import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from './auth-test.helper';
import { createDynamoFake, type DynamoFake } from './dynamo-test.helper';
import { createSubscriberFake } from './subscriber-test.helper';

/** Redis stub covering the RedisService surface used by routes. */
export interface RedisFake {
  ping: () => Promise<string>;
  isReady: () => boolean;
  getEntry: (key: string) => Promise<RedisEntry | null>;
  set: (
    key: string,
    value: string,
    options?: SetOptions,
  ) => Promise<string | null>;
}

/** Initialized e2e application with its provider fakes. */
export interface TestAppContext {
  app: INestApplication;
  redisFake: RedisFake;
  dynamoFake: DynamoFake;
}

/**
 * Boots a Nest application for e2e suites with faked providers.
 *
 * @return The application and its redis and dynamo fakes.
 */
export async function createTestApp(): Promise<TestAppContext> {
  process.env.JWT_PUBLIC_KEY_PATH = join(
    process.cwd(),
    'test',
    'fixtures',
    'test-public.pem',
  );
  process.env.JWT_ISSUER = TEST_JWT_ISSUER;
  process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
  process.env.METRICS_ENABLED = 'false';
  const dynamoFake = createDynamoFake();
  const redisFake: RedisFake = {
    ping: async () => 'PONG',
    isReady: () => true,
    getEntry: vi.fn<(key: string) => Promise<RedisEntry | null>>(),
    set: vi.fn<
      (
        key: string,
        value: string,
        options?: SetOptions,
      ) => Promise<string | null>
    >(),
  };
  const subscriberFake = createSubscriberFake();
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(RedisService)
    .useValue(redisFake)
    .overrideProvider(DynamoService)
    .useValue(dynamoFake)
    .overrideProvider(USER_TOPIC_SUBSCRIBER)
    .useValue(subscriberFake)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.init();
  return { app, redisFake, dynamoFake };
}
