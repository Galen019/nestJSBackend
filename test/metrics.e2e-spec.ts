/**
 * E2E suite for HTTP metrics with mocked providers and JWT auth.
 *
 * - boots via the shared helper (global pipe, WsAdapter, faked providers)
 * - asserts the middleware records template labels for 200s and guard 401s
 * - asserts health probes add no series and key values never leak into labels
 * - asserts unknown paths label as unknown and /metrics 404s on the API port.
 */
import { INestApplication } from '@nestjs/common';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { MetricsService } from './../src/metrics/metrics.service';
import { bearerHeader, signTestToken } from './auth-test.helper';
import {
  createTestApp,
  type RedisFake,
  type TestAppContext,
} from './app-test.helper';

describe('Metrics (e2e)', () => {
  let app: INestApplication;
  let redisFake: RedisFake;
  let context: TestAppContext;

  beforeEach(async () => {
    context = await createTestApp();
    app = context.app;
    redisFake = context.redisFake;
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

  /**
   * Renders the in-process metrics registry (no scrape port in tests).
   *
   * @return The Prometheus exposition body.
   */
  async function metricsBody(): Promise<string> {
    return app.get(MetricsService).getMetrics();
  }

  it('records successful reads with the route template', async () => {
    vi.mocked(redisFake.getEntry).mockResolvedValueOnce({
      value: 'bar',
      expiresIn: 42,
    });

    await request(app.getHttpServer())
      .get('/redis')
      .set('Authorization', authHeader())
      .query({ key: 'metrics-e2e-distinctive-key' })
      .expect(200);

    const body = await metricsBody();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="200"} 1',
    );
    expect(body).not.toContain('metrics-e2e-distinctive-key');
  });

  it('records guard rejections with the matched template', async () => {
    await request(app.getHttpServer())
      .get('/redis')
      .query({ key: 'foo' })
      .expect(401);

    const body = await metricsBody();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="401"} 1',
    );
  });

  it('excludes health probes from the registry', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);

    const body = await metricsBody();
    expect(body).not.toContain('route="/health/live"');
    expect(body).not.toContain('route="/health/ready"');
  });

  it('labels unmatched paths as unknown', async () => {
    await request(app.getHttpServer()).get('/does-not-exist').expect(404);

    const body = await metricsBody();
    expect(body).toContain(
      'http_requests_total{method="GET",route="unknown",status_code="404"} 1',
    );
  });

  it('has no metrics route on the API port', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });
});
