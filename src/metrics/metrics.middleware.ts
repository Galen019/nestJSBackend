/**
 * Records HTTP metrics before guards and observes them when responses finish.
 * Health probes skip recording here via the shared matcher; the scrape path
 * stays excluded in MetricsModule. The unknown-path e2e test verifies unmatched
 * requests pass through this middleware.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { IRoute } from 'express-serve-static-core';
import { isHealthRequest } from '../health/health.constants';
import { UNKNOWN_ROUTE } from './metrics.constants';
import { MetricsService } from './metrics.service';

/**
 * Resolves the low-cardinality route label for a request.
 *
 * - returns the matched Express route template for known routes
 * - returns `unknown` when no route matched (e.g. 404s).
 *
 * @param request Incoming Express request at response finish time.
 * @return The route template or `unknown`.
 */
export function resolveRouteLabel(request: Request): string {
  const candidate: unknown = request.route;
  if (typeof candidate !== 'object' || candidate === null) {
    return UNKNOWN_ROUTE;
  }
  const path: unknown = (candidate as Partial<IRoute>).path;
  if (typeof path === 'string') {
    return path;
  }
  return UNKNOWN_ROUTE;
}

/**
 * Resolves the request URL for probe matching.
 *
 * @param req Incoming Express request.
 * @return The URL or path when known.
 */
function resolveRequestUrl(req: Request): string | undefined {
  return req.originalUrl ?? req.url ?? req.path;
}

/**
 * Parses a Content-Length header into a non-negative byte count.
 *
 * @param value Raw header value from the request or response.
 * @return The byte count, or 0 when absent or unparseable.
 */
function parseByteLength(value: unknown): number {
  const raw: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw !== 'string') {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Middleware recording every HTTP request into the metrics registry.
 *
 * - times the request and observes duration and sizes on response finish
 * - tracks in-flight requests, releasing the gauge on finish or close.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  /** Creates the middleware with the shared metrics registry. */
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Times the request and observes it when the response finishes.
   *
   * @param req Incoming Express request.
   * @param res Outgoing Express response.
   * @param next Passes control to guards, pipes, and handlers.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    if (isHealthRequest(resolveRequestUrl(req))) {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    const method = req.method;
    const requestBytes = parseByteLength(req.headers['content-length']);
    const release = this.metrics.trackInFlight();
    res.once('finish', () => {
      try {
        const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.observeHttp({
          method,
          route: resolveRouteLabel(req),
          statusCode: res.statusCode,
          durationSeconds,
          requestBytes,
          responseBytes: parseByteLength(res.getHeader('content-length')),
        });
      } finally {
        release();
      }
    });
    res.once('close', release);
    next();
  }
}
