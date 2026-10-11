/**
 * Unit suite for MetricsService with direct instantiation.
 *
 * - counter and histogram share method/route/status_code labels
 * - observeHttp rejects non-finite or negative durations
 * - lifecycle skips the scrape server when disabled.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('increments the counter with method, route, and status labels', async () => {
    const service = new MetricsService();

    service.observeHttp({
      method: 'GET',
      route: '/redis',
      statusCode: 200,
      durationSeconds: 0.01,
    });

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="200"} 1',
    );
  });

  it('keeps separate series per status code', async () => {
    const service = new MetricsService();

    service.observeHttp({
      method: 'GET',
      route: '/redis',
      statusCode: 401,
      durationSeconds: 0.002,
    });
    service.observeHttp({
      method: 'POST',
      route: '/redis',
      statusCode: 201,
      durationSeconds: 0.004,
    });

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="401"} 1',
    );
    expect(body).toContain(
      'http_requests_total{method="POST",route="/redis",status_code="201"} 1',
    );
  });

  it('observes durations in the histogram count', async () => {
    const service = new MetricsService();

    service.observeHttp({
      method: 'GET',
      route: '/',
      statusCode: 200,
      durationSeconds: 0.02,
    });

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_request_duration_seconds_count{method="GET",route="/",status_code="200"} 1',
    );
  });

  it('exposes the Prometheus exposition content type', () => {
    const service = new MetricsService();

    expect(service.getContentType()).toContain('text/plain');
  });

  it('rejects non-finite or negative durations', () => {
    const service = new MetricsService();

    for (const durationSeconds of [NaN, Infinity, -0.001]) {
      expect(() =>
        service.observeHttp({
          method: 'GET',
          route: '/',
          statusCode: 200,
          durationSeconds,
        }),
      ).toThrow('durationSeconds');
    }
  });

  it('skips the scrape server when disabled', async () => {
    process.env.METRICS_ENABLED = 'false';
    const service = new MetricsService();

    await service.onModuleInit();
    await service.onModuleDestroy();
  });
});
