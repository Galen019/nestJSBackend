/**
 * Global HTTP metrics middleware.
 *
 * - Runs before guards so 401s, 400s, and 404s are all observed; an
 *   interceptor would miss guard rejections, which is why this is middleware
 * - Observes on response finish when the route template is resolved
 * - Labels use the route template only, never query values or raw paths
 * - Probe exclusion lives in MetricsModule.exclude, not here
 * - The unknown-path e2e test is the contract that forRoutes('*') still
 *   carries unmatched requests through this middleware.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { IRoute } from 'express-serve-static-core';
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
 * Middleware recording every HTTP request into the metrics registry.
 *
 * - times the request and observes it when the response finishes.
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
    const start = process.hrtime.bigint();
    const method = req.method;
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observeHttp({
        method,
        route: resolveRouteLabel(req),
        statusCode: res.statusCode,
        durationSeconds,
      });
    });
    next();
  }
}
