/**
 * E2E suite for HTTP routes with mocked RedisService.
 *
 * - GET /: asserts the hello assertion stays green
 * - GET /health: asserts the readiness probe stays green
 * - GET /redis?key: hit 200, miss 404, missing or blank key 400
 * - POST /redis: 201 without options with edge default TTL, 201 with options
 * - POST /redis: 400 on invalid options, legacy shape, extra fields, missing or blank key
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import type { SetOptions } from 'redis';
import { AppModule } from './../src/app.module';
import { createGlobalValidationPipe } from './../src/app.pipes';
import { DEFAULT_SET_TTL_SECONDS } from './../src/redis/redis.constants';
import { RedisService } from './../src/redis/redis.service';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let redisFake: {
    ping: () => Promise<string>;
    isReady: () => boolean;
    get: (key: string) => Promise<string | null>;
    set: (
      key: string,
      value: string,
      options?: SetOptions,
    ) => Promise<string | null>;
  };

  beforeEach(async () => {
    redisFake = {
      ping: async () => 'PONG',
      isReady: () => true,
      get: vi.fn<(key: string) => Promise<string | null>>(),
      set: vi.fn<
        (
          key: string,
          value: string,
          options?: SetOptions,
        ) => Promise<string | null>
      >(),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue(redisFake)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', redis: 'up' });
  });

  it('/redis?key (GET) resolves the stored value', () => {
    vi.mocked(redisFake.get).mockResolvedValueOnce('bar');
    return request(app.getHttpServer())
      .get('/redis')
      .query({ key: 'foo' })
      .expect(200)
      .expect({ key: 'foo', value: 'bar' });
  });

  it('/redis?key (GET) returns 404 on a cache miss', () => {
    vi.mocked(redisFake.get).mockResolvedValueOnce(null);
    return request(app.getHttpServer())
      .get('/redis')
      .query({ key: 'missing' })
      .expect(404);
  });

  it('/redis (GET) returns 400 without a key', () => {
    return request(app.getHttpServer()).get('/redis').expect(400);
  });

  it('/redis (GET) returns 400 for a blank key', () => {
    return request(app.getHttpServer())
      .get('/redis')
      .query({ key: '   ' })
      .expect(400);
  });

  it('/redis (POST) stores without options with edge default TTL', async () => {
    vi.mocked(redisFake.set).mockResolvedValueOnce('OK');
    await request(app.getHttpServer())
      .post('/redis')
      .send({ key: 'foo', value: 'bar' })
      .expect(201)
      .expect({ key: 'foo', value: 'bar', result: 'OK' });
    expect(redisFake.set).toHaveBeenCalledWith('foo', 'bar', {
      expiration: { type: 'EX', value: DEFAULT_SET_TTL_SECONDS },
    });
  });

  it('/redis (POST) forwards object options', async () => {
    vi.mocked(redisFake.set).mockResolvedValueOnce('OK');
    await request(app.getHttpServer())
      .post('/redis')
      .send({
        key: 'foo',
        value: 'bar',
        options: { expiration: { type: 'EX', value: 60 }, condition: 'NX' },
      })
      .expect(201)
      .expect({ key: 'foo', value: 'bar', result: 'OK' });
    expect(redisFake.set).toHaveBeenCalledWith('foo', 'bar', {
      expiration: { type: 'EX', value: 60 },
      condition: 'NX',
    });
  });

  it('/redis (POST) returns 400 for invalid option values', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({
        key: 'foo',
        value: 'bar',
        options: { expiration: { type: 'EX', value: -1 } },
      })
      .expect(400);
  });

  it('/redis (POST) returns 400 for legacy flat options', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({ key: 'foo', value: 'bar', options: { EX: 60, NX: true } })
      .expect(400);
  });

  it('/redis (POST) returns 400 for extra fields', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({ key: 'foo', value: 'bar', key2: 'baz' })
      .expect(400);
  });

  it('/redis (POST) returns 400 for a missing key', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({ value: 'bar' })
      .expect(400);
  });

  it('/redis (POST) returns 400 for a blank key', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({ key: '   ', value: 'bar' })
      .expect(400);
  });
});
