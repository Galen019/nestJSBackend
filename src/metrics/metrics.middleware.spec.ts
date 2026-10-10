/**
 * Unit suite for MetricsMiddleware.
 *
 * - drives `use()` with stub requests and EventEmitter responses
 * - asserts template-or-unknown labels, including the guard-401 path
 * - asserts key values never reach the recorder.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { MetricsMiddleware, UNKNOWN_ROUTE } from './metrics.middleware';
import { MetricsService } from './metrics.service';

/**
 * Builds a stub request with an optional Express route template.
 *
 * @param method HTTP method as sent by the client.
 * @param path Route template, or undefined for unmatched paths.
 * @return The stubbed request.
 */
function stubRequest(method: string, path?: string): Request {
  return {
    method,
    route: path === undefined ? undefined : { path },
  } as unknown as Request;
}

/**
 * Builds a stub response emitting `finish` on demand.
 *
 * @param statusCode Status Express will send.
 * @return The stubbed response plus an `emitFinish` trigger.
 */
function stubResponse(statusCode: number): {
  res: Response;
  emitFinish: () => void;
} {
  const emitter = new EventEmitter() as unknown as Response;
  (emitter as unknown as Record<string, unknown>)['statusCode'] = statusCode;
  return {
    res: emitter,
    emitFinish: () => (emitter as unknown as EventEmitter).emit('finish'),
  };
}

describe('MetricsMiddleware', () => {
  let module: TestingModule | undefined;
  let middleware: MetricsMiddleware;
  let recordRequest: ReturnType<typeof vi.fn<(observation: unknown) => void>>;
  let next: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    recordRequest = vi.fn<(observation: unknown) => void>();
    next = vi.fn<() => void>();
    module = await Test.createTestingModule({
      providers: [
        MetricsMiddleware,
        { provide: MetricsService, useValue: { recordRequest } },
      ],
    }).compile();
    middleware = module.get<MetricsMiddleware>(MetricsMiddleware);
  });

  /**
   * Runs the middleware and fires `finish` once.
   *
   * @param req Stubbed request.
   * @param res Stubbed response.
   * @param emitFinish Trigger firing the finish event.
   */
  function runAndFinish(
    req: Request,
    res: Response,
    emitFinish: () => void,
  ): void {
    middleware.use(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    emitFinish();
  }

  it('records method, template, and success status', () => {
    const { res, emitFinish } = stubResponse(200);

    runAndFinish(stubRequest('get', '/redis'), res, emitFinish);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith({
      route: '/redis',
      method: 'GET',
      statusCode: 200,
      durationSec: expect.any(Number),
    });
  });

  it('records guard rejections from the response status', () => {
    const { res, emitFinish } = stubResponse(401);

    runAndFinish(stubRequest('GET', '/redis'), res, emitFinish);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/redis',
        method: 'GET',
        statusCode: 401,
      }),
    );
  });

  it('records unknown when Express matched no template', () => {
    const { res, emitFinish } = stubResponse(404);

    runAndFinish(stubRequest('GET'), res, emitFinish);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({ route: UNKNOWN_ROUTE, statusCode: 404 }),
    );
  });

  it('never reads raw URLs, so key values cannot leak', () => {
    const { res, emitFinish } = stubResponse(200);
    const req = {
      method: 'GET',
      route: { path: '/redis' },
      url: '/redis?key=s3cret',
    } as unknown as Request;

    runAndFinish(req, res, emitFinish);

    expect(recordRequest).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordRequest.mock.calls[0])).not.toContain('s3cret');
    expect(recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/redis' }),
    );
  });
});
