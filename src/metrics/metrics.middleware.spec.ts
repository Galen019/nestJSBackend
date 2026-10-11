/**
 * Unit suite for MetricsMiddleware label resolution and observation.
 *
 * - templates label known routes, unmatched requests fall back to unknown
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
 * @return The fake request cast to an Express request.
 */
function fakeRequest(path: string, routePath?: string): Request {
  return {
    path,
    originalUrl: path,
    url: path,
    method: 'GET',
    route: routePath === undefined ? undefined : { path: routePath },
  } as unknown as Request;
}

/**
 * Builds a fake response emitting finish with the given status.
 *
 * @param statusCode Status the handler wrote.
 * @return The emitter-backed fake response.
 */
function fakeResponse(statusCode: number): Response {
  return Object.assign(new EventEmitter(), {
    statusCode,
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
