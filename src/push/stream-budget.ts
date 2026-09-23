/**
 * Per-stream quota policy for the `Publish` fan-out endpoint.
 *
 * - Pure boundary plus accounting, no Nest dependencies
 * - One `consume` call measures, enforces, and hands the chunk forward.
 */

import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  MAX_CHUNKS_PER_STREAM,
  MAX_MESSAGE_BYTES,
  MAX_STREAM_DURATION_MS,
  MAX_TOTAL_CLIENT_IDS_PER_STREAM,
  MAX_TOTAL_MESSAGE_BYTES_PER_STREAM,
} from './push.constants';

/**
 * One chunk after boundary parsing.
 *
 * - `ids` are the raw candidate values, parsed later by the fan-out path
 * - `message` stays opaque until the fan-out path coerces it.
 */
export interface NormalizedChunk {
  ids: unknown[];
  message: unknown;
}

/**
 * Parses a raw stream chunk into ids plus an opaque message.
 *
 * - returns empty ids for missing, non-object, or id-less inputs
 * - reads `clientIds` (proto-loader camelCases wire `client_ids` by default).
 *
 * @param raw Raw chunk from the gRPC stream.
 * @return Normalized ids and message.
 */
export function normalizeChunk(raw: unknown): NormalizedChunk {
  if (typeof raw !== 'object' || raw === null || !('clientIds' in raw)) {
    return { ids: [], message: undefined };
  }
  const { clientIds, message } = raw as {
    clientIds?: unknown;
    message?: unknown;
  };
  return { ids: Array.isArray(clientIds) ? clientIds : [], message };
}

/**
 * Measures the utf8 byte size of one chunk message.
 *
 * - counts bytes of string messages, zero for missing or non-string ones.
 *
 * @param message Raw message value from the chunk.
 * @return Byte usage of the message.
 */
function messageBytes(message: unknown): number {
  return typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : 0;
}

/**
 * Tracks quota consumption of one `Publish` stream.
 *
 * - owns chunk, id, byte, and duration accounting for a single stream
 * - `consume` throws an `RpcException` on any breach, else returns the chunk.
 */
export class StreamBudget {
  private readonly startedAt: number;
  private chunkCount = 0;
  private totalIds = 0;
  private totalBytes = 0;

  /**
   * Opens a budget stamped with the stream start time.
   *
   * - captures the start instant so duration is wall-clock, not per-chunk
   * - accepts a clock override so duration tests avoid real timers.
   *
   * @param now Clock reading milliseconds, defaults to wall-clock time.
   * @return Nothing, the budget starts empty.
   */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
  }

  /**
   * Consumes one chunk against the stream quotas.
   *
   * - rejects over-duration streams before counting the chunk
   * - rejects over-limit chunks, totals, and oversized messages after measuring
   * - empty chunks still consume one chunk of quota, never fan out downstream.
   *
   * @param raw Raw chunk from the gRPC stream.
   * @return The normalized chunk for the fan-out path.
   */
  consume(raw: unknown): NormalizedChunk {
    if (this.now() - this.startedAt > MAX_STREAM_DURATION_MS) {
      throw this.timeoutError();
    }
    this.chunkCount += 1;
    if (this.chunkCount > MAX_CHUNKS_PER_STREAM) {
      throw StreamBudget.exhausted(
        `Publish stream exceeded maximum of ${MAX_CHUNKS_PER_STREAM} chunks`,
      );
    }
    const chunk = normalizeChunk(raw);
    const byteCount = messageBytes(chunk.message);
    if (byteCount > MAX_MESSAGE_BYTES) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `Publish chunk exceeded maximum of ${MAX_MESSAGE_BYTES} message bytes`,
      });
    }
    this.totalIds += chunk.ids.length;
    if (this.totalIds > MAX_TOTAL_CLIENT_IDS_PER_STREAM) {
      throw StreamBudget.exhausted(
        `Publish stream exceeded maximum of ${MAX_TOTAL_CLIENT_IDS_PER_STREAM} total client ids`,
      );
    }
    this.totalBytes += byteCount;
    if (this.totalBytes > MAX_TOTAL_MESSAGE_BYTES_PER_STREAM) {
      throw StreamBudget.exhausted(
        `Publish stream exceeded maximum of ${MAX_TOTAL_MESSAGE_BYTES_PER_STREAM} total message bytes`,
      );
    }
    return chunk;
  }

  /**
   * Builds the duration-exceeded error for idle stream timeouts.
   *
   * - shares one definition with the active-stream duration check in `consume`.
   *
   * @return RpcException carrying RESOURCE_EXHAUSTED.
   */
  timeoutError(): RpcException {
    return StreamBudget.exhausted(
      `Publish stream exceeded maximum duration of ${MAX_STREAM_DURATION_MS}ms`,
    );
  }

  /**
   * Builds a quota-exceeded error.
   *
   * - single factory so all quota breaches share one shape.
   *
   * @param message Human-readable breach description.
   * @return RpcException carrying RESOURCE_EXHAUSTED.
   */
  private static exhausted(message: string): RpcException {
    return new RpcException({ code: status.RESOURCE_EXHAUSTED, message });
  }
}
