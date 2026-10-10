/**
 * Global per-route HTTP metrics middleware.
 *
 * - runs before guards, so 401 rejections are recorded like any other status
 * - resolves the route template at finish time, after Express has matched it
 * - records template-or-unknown only, raw paths never reach the collector
 * - delegates storage and the health skip to MetricsService.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/** Fallback route label when Express matched no template. */
export const UNKNOWN_ROUTE = 'unknown';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  /**
   * Wires the middleware to the shared recorder.
   *
   * @param metricsService OTel-backed recorder for request observations.
   */
  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Times one request and records it when the response finishes.
   *
   * - attaches the listener before `next()` so guard rejections still emit it
   * - reads `route.path` at finish time, when routing has already run.
   *
   * @param req Incoming Express request.
   * @param res Outgoing Express response.
   * @param next Next middleware in the chain.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    const started = performance.now();
    res.once('finish', () => {
      const holder: { route?: { path?: unknown } } = req;
      const template: unknown = holder.route?.path;
      this.metricsService.recordRequest({
        route: typeof template === 'string' ? template : UNKNOWN_ROUTE,
        method: req.method.toUpperCase(),
        statusCode: res.statusCode,
        durationSec: (performance.now() - started) / 1000,
      });
    });
    next();
  }
}
