/**
 * E2E suite for HTTP routes with mocked RedisService and JWT auth.
 *
 * - registers WsAdapter so the `/ws` gateway boots alongside HTTP routes
 * - JWT: test code signs RS256 tokens, API verifies iss/aud/exp via global guard
 * - GET /health stays @Public(); GET / and /redis require a valid Bearer token
 * - GET /redis?key: hit 200 with value and TTL, persistent null, miss 404, missing or blank key 400
 * - POST /redis: 201 without options with edge default TTL, 201 with options
 * - POST /redis: 400 on invalid options, legacy shape, extra fields, missing or blank key
 * - auth negatives: missing/invalid/expired/wrong-iss/wrong-aud/HS256/tampered all 401.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { join } from 'node:path';
import request from 'supertest';
import type { SetOptions } from 'redis';
import { AppModule } from './../src/app.module';
import { createGlobalValidationPipe } from './../src/app.pipes';
import { DEFAULT_SET_TTL_SECONDS } from './../src/redis/redis.constants';
import { RedisService, type RedisEntry } from './../src/redis/redis.service';
import {
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  bearerHeader,
  signTestToken,
} from './auth-test.helper';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let redisFake: {
    ping: () => Promise<string>;
    isReady: () => boolean;
    getEntry: (key: string) => Promise<RedisEntry | null>;
    set: (
      key: string,
      value: string,
      options?: SetOptions,
    ) => Promise<string | null>;
  };

  beforeEach(async () => {
    process.env.JWT_PUBLIC_KEY_PATH = join(
      process.cwd(),
      'test',
      'fixtures',
      'test-public.pem',
    );
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    redisFake = {
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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue(redisFake)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
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

  it('/ (GET) requires auth and returns hello with a token', () => {
    return request(app.getHttpServer())
      .get('/')
      .set('Authorization', authHeader())
      .expect(200)
      .expect('Hello World!');
  });

  it('/ (GET) returns 401 without a token', () => {
    return request(app.getHttpServer()).get('/').expect(401);
  });

  it('/health (GET) stays public without a token', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', redis: 'up' });
  });

  it('/redis?key (GET) resolves the stored value with TTL', () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce({
      value: 'bar',
      expiresIn: 42,
    });
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'foo' })
      .expect(200)
      .expect({ key: 'foo', value: 'bar', expiresIn: 42 });
  });

  it('/redis?key (GET) resolves null expiry for persistent keys', () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce({
      value: 'bar',
      expiresIn: null,
    });
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'foo' })
      .expect(200)
      .expect({ key: 'foo', value: 'bar', expiresIn: null });
  });

  it('/redis?key (GET) returns 404 on a cache miss', () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce(null);
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'missing' })
      .expect(404);
  });

  it('/redis (GET) returns 401 without a token', () => {
    return request(app.getHttpServer())
      .get('/redis')
      .query({ key: 'foo' })
      .expect(401);
  });

  it('/redis (GET) returns 401 for a non-Bearer scheme', () => {
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', `Token ${signTestToken()}`)
      .query({ key: 'foo' })
      .expect(401);
  });

  it('/redis (GET) returns 401 for an expired token', () => {
    const expired = bearerHeader(signTestToken({ expiresIn: '-10s' }));
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', expired)
      .query({ key: 'foo' })
      .expect(401);
  });

  it('/redis (GET) returns 401 for wrong issuer and audience', async () => {
    const badIss = bearerHeader(signTestToken({ issuer: 'evil-issuer' }));
    await request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', badIss)
      .query({ key: 'foo' })
      .expect(401);
    const badAud = bearerHeader(signTestToken({ audience: 'evil-audience' }));
    await request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', badAud)
      .query({ key: 'foo' })
      .expect(401);
  });

  it('/redis (GET) returns 401 for HS256 alg-confusion tokens', () => {
    const hs = bearerHeader(signTestToken({ algorithm: 'HS256' }));
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', hs)
      .query({ key: 'foo' })
      .expect(401);
  });

  it('/redis (GET) returns 400 without a key', () => {
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .expect(400);
  });

  it('/redis (GET) returns 400 for a blank key', () => {
    return request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: '   ' })
      .expect(400);
  });

  it('/redis (POST) stores without options with edge default TTL', async () => {
    vi.mocked(redisFake.set).mockResolvedValueOnce('OK');
    await request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
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
      .set('Authorization', authHeader())
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

  it('/redis (POST) returns 401 without a token', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .send({ key: 'foo', value: 'bar' })
      .expect(401);
  });

  it('/redis (POST) returns 400 for invalid option values', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
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
      .set('Authorization', authHeader())
      .send({ key: 'foo', value: 'bar', options: { EX: 60, NX: true } })
      .expect(400);
  });

  it('/redis (POST) returns 400 for extra fields', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
      .send({ key: 'foo', value: 'bar', key2: 'baz' })
      .expect(400);
  });

  it('/redis (POST) returns 400 for a missing key', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
      .send({ value: 'bar' })
      .expect(400);
  });

  it('/redis (POST) returns 400 for a blank key', () => {
    return request(app.getHttpServer())
      .post('/redis')
      .set('Authorization', authHeader())
      .send({ key: '   ', value: 'bar' })
      .expect(400);
  });
});
