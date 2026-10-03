/**
 * gRPC fan-out service.
 *
 * - Owns the whole `Publish` stream pipeline: slots, quotas, spans, fan-out
 * - Thin callers (`publish`) stay for single-chunk use; streaming callers use
 *   `publishStream`, which is the only place push spans are created
 * - Fire-and-forget: invalid ids are dropped, never thrown
 * - Span attributes are counts and sizes only, never ids lists or bodies:
 *   `push.received`, `push.chunk.index`, `push.client.count`,
 *   `push.message.bytes`, `push.sent.count`, `push.skipped.count`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
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
import { parseClientId, type ClientId } from '../ws/session.interface';
import { WsService, type FanOutResult } from '../ws/ws.service';
import {
  MAX_CLIENT_IDS,
  MAX_CONCURRENT_STREAMS,
  MAX_MESSAGE_CHARS,
  MAX_STREAM_DURATION_MS,
} from './push.constants';
import {
  messageBytes,
  normalizeChunk,
  StreamBudget,
  type NormalizedChunk,
} from './stream-budget';

/**
 * Raw gRPC payload shape after proto-loader.
 *
 * - `clientIds` is the camelCased form of wire `client_ids`
 * - the camelCase mapping relies on proto-loader's default `keepCase: false`
 * - fields stay optional because the loader omits empty values.
 */
export interface PublishRequestGrpc {
  clientIds?: string[];
  message?: string;
}

/**
 * Summary emitted once when the client closes the stream.
 *
 * - Counts received chunks, not delivered sockets, by design
 * - Per-id receipts are intentionally omitted (fire-and-forget).
 */
export interface PublishSummary {
  received: number;
}

/** Tracer name for push stream/chunk spans. */
export const PUSH_TRACER_NAME = 'gRPC-stream-push';

/** Stream span name for one `Publish` stream. */
export const PUSH_PUBLISH_SPAN = 'push.publish';

/** Chunk span name for one `PublishRequest` chunk. */
export const PUSH_CHUNK_SPAN = 'push.chunk';

/**
 * Parses and fans out `PublishRequest` chunks to WebSocket sessions.
 *
 * - Owns slots, quotas, spans, and boundary validation so the controller
 *   stays a thin auth adapter
 * - Caps, parses, coerces, then delegates to `WsService.sendToClients`.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly tracer: Tracer = trace.getTracer(PUSH_TRACER_NAME);
  private activeStreams = 0;

  constructor(private readonly wsService: WsService) {}

  /**
   * Reserves a slot for one `Publish` stream.
   *
   * - returns undefined without mutating state when at MAX_CONCURRENT_STREAMS
   * - otherwise returns a release handle the caller runs exactly once.
   *
   * @return Release handle, or undefined when no slot is free.
   */
  beginStream(): (() => void) | undefined {
    if (this.activeStreams >= MAX_CONCURRENT_STREAMS) {
      return undefined;
    }
    this.activeStreams += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeStreams -= 1;
      }
    };
  }

  /**
   * Consumes a stream of chunks and emits the close summary.
   *
   * - rejects with RESOURCE_EXHAUSTED when no stream slot is free
   * - each chunk passes through `StreamBudget.consume`, then fans out
   * - counts chunks with `reduce`, maps the count to `{ received }`
   * - releases the stream slot on completion, error, or cancellation
   * - traces the stream plus one child span per chunk (index, id count,
   *   byte size, sent/skipped counts, never bodies).
   *
   * @param messages Observable of stream chunks from the gRPC caller.
   * @return Observable emitting one summary on stream completion.
   */
  publishStream(
    messages: Observable<PublishRequestGrpc>,
  ): Observable<PublishSummary> {
    const release = this.beginStream();
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
    const streamSpan = this.tracer.startSpan(PUSH_PUBLISH_SPAN);
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
          this.publishChunk(budget, chunkIndex, message, streamContext);
          chunkIndex += 1;
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
   * - quota breaches end the chunk span as ERROR and rethrow to end the RPC
   * - attributes are counts and sizes only, never ids lists or bodies.
   *
   * @param budget Per-stream quota tracker.
   * @param index Zero-based chunk position in the stream.
   * @param message Raw chunk from the gRPC stream.
   * @param parent Stream span context to parent the chunk span to.
   * @return Nothing, the chunk is fanned out as a side effect.
   */
  private publishChunk(
    budget: StreamBudget,
    index: number,
    message: PublishRequestGrpc,
    parent: Context,
  ): void {
    const chunkSpan = this.tracer.startSpan(PUSH_CHUNK_SPAN, undefined, parent);
    chunkSpan.setAttribute('push.chunk.index', index);
    try {
      const chunk = budget.consume(message);
      const result = this.publishNormalized(chunk);
      chunkSpan.setAttribute('push.client.count', chunk.ids.length);
      chunkSpan.setAttribute(
        'push.message.bytes',
        messageBytes(message.message),
      );
      chunkSpan.setAttribute('push.sent.count', result.sent);
      chunkSpan.setAttribute('push.skipped.count', result.skipped);
    } catch (error) {
      recordSpanError(chunkSpan, error);
      throw error;
    } finally {
      chunkSpan.end();
    }
  }

  /**
   * Fans out one stream chunk to matching sockets, best-effort.
   *
   * - normalizes, then delegates to `publishNormalized`
   * - never throws, missing/closed sockets are skipped inside `WsService`.
   *
   * @param raw Raw chunk from the gRPC stream.
   * @return Nothing, delivery counts are logged at debug level.
   */
  publish(raw: unknown): void {
    this.publishNormalized(normalizeChunk(raw));
  }

  /**
   * Fans out one already-normalized chunk to matching sockets, best-effort.
   *
   * - caps ids at MAX_CLIENT_IDS, drops blanks/unparseable ids
   * - coerces `message`: JSON strings are parsed, other values forwarded as-is
   * - never throws, missing/closed sockets are skipped inside `WsService`.
   *
   * @param chunk Normalized ids plus opaque message from the quota path.
   * @return Sent/skipped counts plus the serialized payload size in bytes.
   */
  publishNormalized(chunk: NormalizedChunk): FanOutResult {
    const { ids, message } = chunk;
    const capped = ids.slice(0, MAX_CLIENT_IDS);
    if (ids.length > MAX_CLIENT_IDS) {
      this.logger.warn(
        `Dropping ${ids.length - MAX_CLIENT_IDS} clientIds over cap ${MAX_CLIENT_IDS}`,
      );
    }
    const parsed: ClientId[] = [];
    for (const id of capped) {
      const clientId = parseClientId(id);
      if (clientId !== undefined) {
        parsed.push(clientId);
      }
    }
    if (parsed.length === 0) {
      return { sent: 0, skipped: 0, bytes: 0 };
    }
    const payload = this.coerceMessage(message);
    const result = this.wsService.sendToClients(parsed, payload);
    this.logger.debug(
      `Fan-out to ${parsed.length} clients: sent ${result.sent}, skipped ${result.skipped}`,
    );
    return result;
  }

  /**
   * Coerces the opaque message for the WS JSON send path.
   *
   * - JSON strings are parsed so clients receive objects, not double-encoded text
   * - oversized strings are truncated to MAX_MESSAGE_CHARS first
   * - non-string values are forwarded untouched for `sendToClient` to stringify.
   *
   * @param message Raw message value from the chunk.
   * @return Payload suitable for `WsService.sendToClients`.
   */
  private coerceMessage(message: unknown): unknown {
    if (typeof message !== 'string') {
      return message;
    }
    const capped =
      message.length > MAX_MESSAGE_CHARS
        ? message.slice(0, MAX_MESSAGE_CHARS)
        : message;
    const trimmed = capped.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return capped;
      }
    }
    return capped;
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
