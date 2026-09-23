/**
 * Unit suite for StreamBudget quota policy.
 *
 * - pure logic, no Nest module needed
 * - covers chunk, id, byte, and duration quotas plus normalization
 * - covers the shared timeout error factory
 */
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { describe, it, expect } from 'vitest';
import {
  MAX_CHUNKS_PER_STREAM,
  MAX_MESSAGE_BYTES,
  MAX_STREAM_DURATION_MS,
  MAX_TOTAL_CLIENT_IDS_PER_STREAM,
  MAX_TOTAL_MESSAGE_BYTES_PER_STREAM,
} from './push.constants';
import { normalizeChunk, StreamBudget } from './stream-budget';

/**
 * Runs a closure, mapping the outcome to a gRPC status code.
 *
 * - returns -1 when the closure does not throw
 * - reads the `{ code }` payload of a thrown RpcException.
 *
 * @param fn Closure expected to throw an RpcException.
 * @return The status code, or -1 when nothing was thrown.
 */
function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof RpcException) {
      const payload = error.getError();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'code' in payload &&
        typeof payload.code === 'number'
      ) {
        return payload.code;
      }
    }
    throw error;
  }
  return -1;
}

describe('normalizeChunk', () => {
  it('splits a chunk into ids plus message', () => {
    expect(normalizeChunk({ clientIds: ['a', 'b'], message: 'hi' })).toEqual({
      ids: ['a', 'b'],
      message: 'hi',
    });
  });

  it('returns empty ids for missing or non-object chunks', () => {
    expect(normalizeChunk(undefined)).toEqual({
      ids: [],
      message: undefined,
    });
    expect(normalizeChunk({ clientIds: 'nope', message: 42 })).toEqual({
      ids: [],
      message: 42,
    });
  });
});

describe('StreamBudget', () => {
  it('returns the normalized chunk under quota', () => {
    const budget = new StreamBudget();

    expect(budget.consume({ clientIds: ['a'], message: '{"x":1}' })).toEqual({
      ids: ['a'],
      message: '{"x":1}',
    });
  });

  it('counts empty chunks against the chunk quota', () => {
    const budget = new StreamBudget();
    for (let index = 0; index < MAX_CHUNKS_PER_STREAM; index += 1) {
      budget.consume({});
    }

    expect(codeOf(() => budget.consume({}))).toBe(status.RESOURCE_EXHAUSTED);
  });

  it('terminates past the total id limit', () => {
    const budget = new StreamBudget();
    const ids = Array.from(
      { length: MAX_TOTAL_CLIENT_IDS_PER_STREAM + 1 },
      (_, index) => `c-${String(index)}`,
    );

    expect(
      codeOf(() => budget.consume({ clientIds: ids, message: 'hi' })),
    ).toBe(status.RESOURCE_EXHAUSTED);
  });

  it('terminates with INVALID_ARGUMENT on an oversized chunk message', () => {
    const budget = new StreamBudget();

    expect(
      codeOf(() =>
        budget.consume({
          clientIds: ['a'],
          message: 'x'.repeat(MAX_MESSAGE_BYTES + 1),
        }),
      ),
    ).toBe(status.INVALID_ARGUMENT);
  });

  it('terminates past the total byte limit', () => {
    const budget = new StreamBudget();
    const chunk = { clientIds: ['a'], message: 'x'.repeat(MAX_MESSAGE_BYTES) };
    const fitting = Math.floor(
      MAX_TOTAL_MESSAGE_BYTES_PER_STREAM / MAX_MESSAGE_BYTES,
    );
    for (let index = 0; index < fitting; index += 1) {
      budget.consume(chunk);
    }

    expect(codeOf(() => budget.consume(chunk))).toBe(status.RESOURCE_EXHAUSTED);
  });

  it('terminates over-duration streams without real timers', () => {
    let clock = 1000;
    const budget = new StreamBudget(() => clock);
    clock += MAX_STREAM_DURATION_MS + 1;

    expect(codeOf(() => budget.consume({ clientIds: ['a'] }))).toBe(
      status.RESOURCE_EXHAUSTED,
    );
  });

  it('builds a RESOURCE_EXHAUSTED timeout error', () => {
    expect(new StreamBudget().timeoutError().getError()).toEqual({
      code: status.RESOURCE_EXHAUSTED,
      message: `Publish stream exceeded maximum duration of ${MAX_STREAM_DURATION_MS}ms`,
    });
  });
});
