/**
 * Unit suite for MetricsService with direct instantiation.
 *
 * - counter and histogram share method/route/status_code labels
 * - size summaries record request and response bytes per observation
 * - the in-flight gauge tracks requests and releases once
 * - default Node.js/process metrics are registered on the same registry
 * - observeHttp rejects non-finite or negative durations and sizes
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
      requestBytes: 0,
      responseBytes: 0,
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
      requestBytes: 0,
      responseBytes: 0,
    });
    service.observeHttp({
      method: 'POST',
      route: '/redis',
      statusCode: 201,
      durationSeconds: 0.004,
      requestBytes: 0,
      responseBytes: 0,
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
      requestBytes: 0,
      responseBytes: 0,
    });

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_request_duration_seconds_count{method="GET",route="/",status_code="200"} 1',
    );
  });

  it('records request and response sizes in the summaries', async () => {
    const service = new MetricsService();

    service.observeHttp({
      method: 'POST',
      route: '/redis',
      statusCode: 200,
      durationSeconds: 0.01,
      requestBytes: 128,
      responseBytes: 512,
    });

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_request_size_bytes_sum{method="POST",route="/redis",status_code="200"} 128',
    );
    expect(body).toContain(
      'http_response_size_bytes_sum{method="POST",route="/redis",status_code="200"} 512',
    );
  });

  it('tracks in-flight requests and releases the gauge once', async () => {
    const service = new MetricsService();

    const release = service.trackInFlight();
    const during = await service.getMetrics();
    expect(during).toContain('http_in_flight_requests 1');

    release();
    release();

    const after = await service.getMetrics();
    expect(after).toContain('http_in_flight_requests 0');
  });

  it('exposes default Node.js and process metrics', async () => {
    const service = new MetricsService();

    const body = await service.getMetrics();
    expect(body).toContain('nodejs_version_info');
    expect(body).toContain('nodejs_heap_size_total_bytes');
    expect(body).toContain('process_cpu_seconds_total');
  });

  it('exposes the Prometheus exposition content type', () => {
    const service = new MetricsService();

    expect(service.getContentType()).toContain('text/plain');
  });

  it('rejects non-finite or negative durations and sizes', () => {
    const service = new MetricsService();
    const base = {
      method: 'GET',
      route: '/',
      statusCode: 200,
      durationSeconds: 0.01,
      requestBytes: 0,
      responseBytes: 0,
    };

    for (const durationSeconds of [NaN, Infinity, -0.001]) {
      expect(() => service.observeHttp({ ...base, durationSeconds })).toThrow(
        'durationSeconds',
      );
    }

    for (const requestBytes of [NaN, Infinity, -1]) {
      expect(() => service.observeHttp({ ...base, requestBytes })).toThrow(
        'byte sizes',
      );
    }

    for (const responseBytes of [NaN, Infinity, -1]) {
      expect(() => service.observeHttp({ ...base, responseBytes })).toThrow(
        'byte sizes',
      );
    }
  });

  it('skips the scrape server when disabled', async () => {
    process.env.METRICS_ENABLED = 'false';
    const service = new MetricsService();

    await service.onModuleInit();
    await service.onModuleDestroy();
  });
});
