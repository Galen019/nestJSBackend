/**
 * gRPC streaming controller for WS fan-out.
 *
 * - Thin adapter: converts the request Observable into a summary Observable
 * - Quotas live in `StreamBudget`, sends in `PushService`, slots in both
 * - This file only wires the three together over one HTTP/2 stream.
 */

import { Controller } from '@nestjs/common';
import { GrpcStreamMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { finalize, map, reduce, tap, throwError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import {
  MAX_CONCURRENT_STREAMS,
  MAX_STREAM_DURATION_MS,
  PUBLISH_METHOD,
  PUSH_SERVICE,
} from './push.constants';
import { PushService, type PublishRequestGrpc } from './push.service';
import { StreamBudget } from './stream-budget';

/**
 * Summary emitted once when the client closes the stream.
 *
 * - Counts received chunks, not delivered sockets, by design
 * - Per-id receipts are intentionally omitted (fire-and-forget).
 */
export interface PublishSummary {
  received: number;
}

/**
 * Client-streaming endpoint `PushService.Publish`.
 *
 * - stays open for many `PublishRequest` chunks over one HTTP/2 stream
 * - each chunk is fanned out independently without replying mid-stream
 * - completes with `{ received }` when the client ends the stream
 * - quota breaches terminate the RPC via `StreamBudget`.
 */
@Controller()
export class PushController {
  constructor(
    private readonly pushService: PushService,
    private readonly verifier: JwtVerifierService,
  ) {}

  /**
   * Consumes the request stream and emits the close summary.
   *
   * - verifies `authorization: Bearer <jwt>` metadata first (UNAUTHENTICATED on failure)
   * - rejects with RESOURCE_EXHAUSTED when no stream slot is free
   * - each chunk passes through `StreamBudget.consume`, then fans out
   * - counts chunks with `reduce`, maps the count to `{ received }`
   * - releases the stream slot on completion, error, or cancellation.
   *
   * @param messages Observable of stream chunks from the gRPC caller.
   * @param metadata gRPC call metadata carrying the Bearer token.
   * @return Observable emitting one summary on stream completion.
   */
  @GrpcStreamMethod(PUSH_SERVICE, PUBLISH_METHOD)
  publish(
    messages: Observable<PublishRequestGrpc>,
    metadata?: Metadata,
  ): Observable<PublishSummary> {
    try {
      this.verifier.verifyHeader(readGrpcAuthHeader(metadata));
    } catch {
      return throwError(
        () =>
          new RpcException({
            code: status.UNAUTHENTICATED,
            message: 'Invalid or expired token',
          }),
      );
    }
    const release = this.pushService.beginStream();
    if (release === undefined) {
      return throwError(
        () =>
          new RpcException({
            code: status.RESOURCE_EXHAUSTED,
            message: `Too many concurrent Publish streams (max ${MAX_CONCURRENT_STREAMS})`,
          }),
      );
    }
    const budget = new StreamBudget();
    return messages.pipe(
      timeout({
        each: MAX_STREAM_DURATION_MS,
        with: () => throwError(() => budget.timeoutError()),
      }),
      tap((message) => {
        this.pushService.publishNormalized(budget.consume(message));
      }),
      reduce((count) => count + 1, 0),
      map((received) => ({ received })),
      finalize(release),
    );
  }
}

/**
 * Reads the `authorization` header from gRPC call metadata.
 *
 * - grpc-js lowercase-normalizes metadata keys, so one lookup suffices
 * - returns the raw header value so the verifier enforces the Bearer scheme
 * - returns undefined when metadata or the entry is absent.
 *
 * @param metadata gRPC call metadata from the stream handler.
 * @return The raw authorization header, or undefined when absent.
 */
function readGrpcAuthHeader(
  metadata: Metadata | undefined,
): string | undefined {
  const raw = metadata?.getMap()?.['authorization'];
  return typeof raw === 'string' ? raw : undefined;
}
