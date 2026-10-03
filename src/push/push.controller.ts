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
import {
  context,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
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
  private readonly tracer: Tracer = trace.getTracer('gRPC-stream-push');

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
   * - releases the stream slot on completion, error, or cancellation, even when
   *   ending the span throws, so tracing can never leak stream slots
   * - traces the stream (`push.publish`) plus one child span per chunk
   *   (`push.chunk` with index, id count, and byte size, never bodies)
   * - fan-out `ws.send` spans parent under their `push.chunk` span via an
   *   explicitly threaded chunk context (no ambient propagation).
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
    const streamSpan = this.tracer.startSpan('push.publish');
    streamSpan.setAttributes({
      'rpc.system': 'grpc',
      'rpc.service': 'push.PushService',
      'rpc.method': 'Publish',
    });
    const streamContext = trace.setSpan(context.active(), streamSpan);
    let chunkIndex = 0;
    return messages.pipe(
      timeout({
        each: MAX_STREAM_DURATION_MS,
        with: () => throwError(() => budget.timeoutError()),
      }),
      tap({
        next: (message) => {
          this.publishChunk(streamContext, budget, chunkIndex, message);
          chunkIndex += 1;
        },
        error: (error: unknown) => {
          recordSpanError(streamSpan, error);
        },
      }),
      reduce((count) => count + 1, 0),
      tap({
        next: (received) => {
          streamSpan.setAttribute('push.received', received);
        },
        error: (error: unknown) => {
          recordSpanError(streamSpan, error);
        },
      }),
      map((received) => ({ received })),
      finalize(() => {
        try {
          streamSpan.end();
        } finally {
          release();
        }
      }),
    );
  }

  /**
   * Fans out one chunk inside its own child span.
   *
   * - explicit parent context because RxJS breaks ambient context propagation
   * - quota breaches end the chunk span as ERROR and rethrow to end the RPC
   * - attributes are counts and sizes only, never ids lists or bodies
   * - threads the chunk context through the fan-out so `ws.send` spans parent
   *   under this chunk explicitly (no reliance on ambient propagation, which
   *   is inert without an AsyncLocalStorage context manager).
   *
   * @param parent Stream span context to parent the chunk span to.
   * @param budget Per-stream quota tracker.
   * @param index Zero-based chunk position in the stream.
   * @param message Raw chunk from the gRPC stream.
   * @return Nothing, the chunk is fanned out as a side effect.
   */
  private publishChunk(
    parent: Context,
    budget: StreamBudget,
    index: number,
    message: PublishRequestGrpc,
  ): void {
    const chunkSpan = this.tracer.startSpan('push.chunk', undefined, parent);
    const chunkContext = trace.setSpan(parent, chunkSpan);
    chunkSpan.setAttribute('grpc.chunk.index', index);
    try {
      const chunk = budget.consume(message);
      chunkSpan.setAttribute('grpc.client_ids.count', chunk.ids.length);
      chunkSpan.setAttribute(
        'grpc.message.bytes',
        typeof chunk.message === 'string'
          ? Buffer.byteLength(chunk.message, 'utf8')
          : 0,
      );
      this.pushService.publishNormalized(chunk, chunkContext);
    } catch (error) {
      recordSpanError(chunkSpan, error);
      throw error;
    } finally {
      chunkSpan.end();
    }
  }
}

/**
 * Records an error on a span without leaking payloads.
 *
 * - records the exception for stack detail, marks the span ERROR
 * - status carries no message so raw payloads never land in span metadata.
 *
 * @param span Span to mark as failed.
 * @param error Raw error value from the stream.
 * @return Nothing, the span is updated in place.
 */
function recordSpanError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
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
