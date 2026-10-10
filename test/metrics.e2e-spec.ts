/**
 * E2E suite for per-route metrics through the full Nest pipeline.
 *
 * - boots AppModule with the global MetricsMiddleware registered
 * - spies on MetricsService.recordRequest to assert normalized labels
 * - GET/POST /redis record `/redis` with method and status, never key values
 * - guard 401s are recorded, GET /health forwards to the recorder alone,
 *   which drops it before touching instruments (see MetricsService spec).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { createGlobalValidationPipe } from './../src/app.pipes';
import { DynamoService } from './../src/dynamo/dynamo.service';
import { MetricsService } from './../src/metrics/metrics.service';
import { RedisService } from './../src/redis/redis.service';
import { USER_TOPIC_SUBSCRIBER } from './../src/user-topics/user-topic.service';
import {
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  bearerHeader,
  signTestToken,
} from './auth-test.helper';
import { createDynamoFake, type DynamoFake } from './dynamo-test.helper';
import { createRedisFake, type RedisFake } from './redis-test.helper';
import { createSubscriberFake } from './subscriber-test.helper';

describe('Metrics (e2e)', () => {
  let app: INestApplication;
  let dynamoFake: DynamoFake;
  let redisFake: RedisFake;
  let recordRequest: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.JWT_PUBLIC_KEY_PATH = join(
      process.cwd(),
      'test',
      'fixtures',
      'test-public.pem',
    );
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    dynamoFake = createDynamoFake();
    redisFake = createRedisFake();
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

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    recordRequest = vi.spyOn(
      app.get<MetricsService>(MetricsService),
      'recordRequest',
    );
  });

  afterEach(async () => {
    await app?.close();
  });

  /**
   * Signs a valid test token for the happy path.
   *
   * @return The `Bearer <jwt>` header value.
   */
  function authHeader(): string {
    return bearerHeader(signTestToken());
  }

  it('records GET /redis with a normalized route', async () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce({
      value: 'bar',
      expiresIn: 42,
    });

    await request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'foo' })
      .expect(200);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/redis',
      method: 'GET',
      statusCode: 200,
      durationSec: expect.any(Number),
    });
    expect(JSON.stringify(recordRequest.mock.calls[0])).not.toContain('foo');
  });

  it('records POST /redis with a normalized route', async () => {
    vi.mocked(redisFake.set).mockResolvedValueOnce('OK');

    await request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
      .send({ key: 'foo', value: 'bar' })
      .expect(201);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/redis',
      method: 'POST',
      statusCode: 201,
      durationSec: expect.any(Number),
    });
    expect(JSON.stringify(recordRequest.mock.calls[0])).not.toContain('foo');
  });

  it('records the error status on a cache miss', async () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce(null);

    await request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'missing' })
      .expect(404);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/redis',
      method: 'GET',
      statusCode: 404,
      durationSec: expect.any(Number),
    });
  });

  it('records guard rejections with the 401 status', async () => {
    await request(app.getHttpServer())
      .get('/redis')
      .query({ key: 'foo' })
      .expect(401);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/redis',
      method: 'GET',
      statusCode: 401,
      durationSec: expect.any(Number),
    });
  });

  it('forwards health probes to the recorder, which skips them', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/health',
      method: 'GET',
      statusCode: 200,
      durationSec: expect.any(Number),
    });
  });
});
