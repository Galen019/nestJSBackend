/**
 * Unit suite for MetricsMiddleware label resolution and observation.
 *
 * - templates label known routes, unmatched requests fall back to unknown
 * - records request/response sizes and releases the in-flight gauge
 * - releases the gauge on disconnect and avoids a double release
 * - health probes skip recording via the shared matcher.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { MetricsMiddleware, resolveRouteLabel } from './metrics.middleware';
import { MetricsService } from './metrics.service';

/**
 * Builds a fake request with the given path and matched route template.
 *
 * @param path Request pathname.
 * @param routePath Matched Express route template, if any.
 * @param contentLength Request Content-Length header when provided.
 * @return The fake request cast to an Express request.
 */
function fakeRequest(
  path: string,
  routePath?: string,
  contentLength?: number,
): Request {
  return {
    path,
    originalUrl: path,
    url: path,
    method: 'GET',
    headers:
      contentLength === undefined
        ? {}
        : { 'content-length': String(contentLength) },
    route: routePath === undefined ? undefined : { path: routePath },
  } as unknown as Request;
}

/**
 * Builds a fake response with the given status and optional Content-Length.
 *
 * @param statusCode Status the handler wrote.
 * @param contentLength Response Content-Length header when provided.
 * @return The emitter-backed fake response.
 */
function fakeResponse(statusCode: number, contentLength?: number): Response {
  return Object.assign(new EventEmitter(), {
    statusCode,
    getHeader: (name: string) =>
      name.toLowerCase() === 'content-length' ? contentLength : undefined,
  }) as unknown as Response;
}

/**
 * Builds a no-op next function.
 *
 * @return The fake next function.
 */
function fakeNext(): NextFunction {
  return vi.fn<() => void>() as unknown as NextFunction;
}

describe('resolveRouteLabel', () => {
  it('resolves the matched route template', () => {
    expect(resolveRouteLabel(fakeRequest('/redis', '/redis'))).toBe('/redis');
  });

  it('falls back to unknown without a matched route', () => {
    expect(resolveRouteLabel(fakeRequest('/nope'))).toBe('unknown');
  });
});

describe('MetricsMiddleware', () => {
  it('observes completed requests with template labels', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(200);

    middleware.use(fakeRequest('/redis', '/redis'), res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledOnce();
    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="200"} 1',
    );
    expect(body).not.toContain('key=foo');
  });

  it('observes rejections with the matched template', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(401);

    middleware.use(fakeRequest('/redis', '/redis'), res, next);
    res.emit('finish');

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="401"} 1',
    );
  });

  it('records sizes and releases the in-flight gauge on finish', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(200, 512);

    middleware.use(fakeRequest('/redis', '/redis', 128), res, next);

    const during = await service.getMetrics();
    expect(during).toContain('http_in_flight_requests 1');

    res.emit('finish');

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_request_size_bytes_sum{method="GET",route="/redis",status_code="200"} 128',
    );
    expect(body).toContain(
      'http_response_size_bytes_sum{method="GET",route="/redis",status_code="200"} 512',
    );
    expect(body).toContain('http_in_flight_requests 0');
  });

  it('releases the gauge when the client disconnects without finishing', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(200);

    middleware.use(fakeRequest('/redis', '/redis'), res, next);
    res.emit('close');

    const body = await service.getMetrics();
    expect(body).toContain('http_in_flight_requests 0');
    expect(body).not.toContain('http_requests_total{');
  });

  it('does not double-decrement when close follows finish', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(200);

    middleware.use(fakeRequest('/redis', '/redis'), res, next);
    res.emit('finish');
    res.emit('close');

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="/redis",status_code="200"} 1',
    );
    expect(body).toContain('http_in_flight_requests 0');
  });

  it('labels unmatched requests as unknown', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(404);

    middleware.use(fakeRequest('/nope'), res, next);
    res.emit('finish');

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="unknown",status_code="404"} 1',
    );
  });

  it('skips live and ready probes without recording', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);

    for (const path of [
      '/health/live',
      '/health/live/',
      '/health/ready?full=1',
    ]) {
      const next = fakeNext();
      const res = fakeResponse(200);
      middleware.use(fakeRequest(path), res, next);
      res.emit('finish');
      expect(next).toHaveBeenCalledOnce();
    }

    const body = await service.getMetrics();
    expect(body).not.toContain('route="/health/live"');
    expect(body).not.toContain('route="/health/ready"');
    expect(body).not.toContain('route="unknown"');
  });

  it('records bare health paths that are not probes', async () => {
    const service = new MetricsService();
    const middleware = new MetricsMiddleware(service);
    const next = fakeNext();
    const res = fakeResponse(404);

    middleware.use(fakeRequest('/health'), res, next);
    res.emit('finish');

    const body = await service.getMetrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="unknown",status_code="404"} 1',
    );
  });
});
