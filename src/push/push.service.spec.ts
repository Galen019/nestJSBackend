/**
 * Unit suite for PushService boundary parsing plus fan-out.
 *
 * - mocks WsService.sendToClients, asserts parsed ids and coerced payloads
 * - covers id parsing, blanks dropped, cap enforced, fire-and-forget empties
 * - covers JSON message parsing, truncation, and non-string passthrough
 * - covers stream slot handles up to the concurrency cap.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { SpanStatusCode } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { concat, lastValueFrom, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import {
  startInMemoryTracing,
  type InMemoryTracing,
} from '../../test/tracing-test.helper';
import { WsService } from '../ws/ws.service';
import {
  MAX_CLIENT_IDS,
  MAX_CONCURRENT_STREAMS,
  MAX_MESSAGE_CHARS,
} from './push.constants';
import {
  PUSH_CHUNK_SPAN,
  PUSH_PUBLISH_SPAN,
  PushService,
  type PublishSummary,
} from './push.service';

describe('PushService', () => {
  let service: PushService;
  let module: TestingModule | undefined;
  let sendToClients: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with a mocked WsService.
   *
   * - fresh mock per test so call counts never leak
   * - tracks the module so it can be closed after each test.
   *
   * @return The compiled push service.
   */
  async function compile(): Promise<PushService> {
    sendToClients = vi.fn(() => ({ sent: 0, skipped: 0, bytes: 0 }));
    module = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: WsService, useValue: { sendToClients } },
      ],
    }).compile();
    return module.get<PushService>(PushService);
  }

  beforeEach(async () => {
    service = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('fans out camelCase ids with a JSON message parsed to an object', () => {
    service.publish({ clientIds: ['a', 'b'], message: '{"x":1}' });

    expect(sendToClients).toHaveBeenCalledTimes(1);
    expect(sendToClients).toHaveBeenCalledWith(['a', 'b'], { x: 1 });
  });

  it('forwards plain string messages untouched', () => {
    service.publish({ clientIds: ['a'], message: 'hello' });

    expect(sendToClients).toHaveBeenCalledWith(['a'], 'hello');
  });

  it('drops blank ids and does nothing when none remain', () => {
    service.publish({ clientIds: ['   ', ''], message: 'hi' });

    expect(sendToClients).not.toHaveBeenCalled();
  });

  it('does nothing for missing or non-object chunks', () => {
    service.publish(undefined);
    service.publish(null);
    service.publish('nope');
    service.publish({});

    expect(sendToClients).not.toHaveBeenCalled();
  });

  it('caps ids at MAX_CLIENT_IDS', () => {
    const ids = Array.from(
      { length: MAX_CLIENT_IDS + 5 },
      (_, i) => `c-${String(i)}`,
    );

    service.publish({ clientIds: ids, message: 'hi' });

    expect(sendToClients).toHaveBeenCalledTimes(1);
    const sentIds = sendToClients.mock.calls[0]?.[0] as string[];
    expect(sentIds).toHaveLength(MAX_CLIENT_IDS);
  });

  it('truncates oversized string messages', () => {
    service.publish({
      clientIds: ['a'],
      message: 'x'.repeat(MAX_MESSAGE_CHARS + 10),
    });

    const payload = sendToClients.mock.calls[0]?.[1] as string;
    expect(payload).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it('forwards non-string messages untouched', () => {
    const message = { type: 'PING' };

    service.publish({ clientIds: ['a'], message });

    expect(sendToClients).toHaveBeenCalledWith(['a'], message);
  });

  it('fans out an already-normalized chunk and returns the fan-out result', () => {
    sendToClients.mockReturnValue({ sent: 1, skipped: 2, bytes: 12 });

    const result = service.publishNormalized({ ids: ['a'], message: 'hello' });

    expect(sendToClients).toHaveBeenCalledWith(['a'], 'hello');
    expect(result).toEqual({ sent: 1, skipped: 2, bytes: 12 });
  });

  it('hands out release handles up to the concurrency cap', () => {
    const releases: Array<() => void> = [];
    for (let index = 0; index < MAX_CONCURRENT_STREAMS; index += 1) {
      const release = service.beginStream();
      expect(release).toBeDefined();
      if (release !== undefined) {
        releases.push(release);
      }
    }

    expect(service.beginStream()).toBeUndefined();
    releases.forEach((release) => release());
    const retry = service.beginStream();

    expect(retry).toBeDefined();
  });

  it('ignores double releases of one handle', () => {
    const release = service.beginStream();

    expect(release).toBeDefined();
    release?.();
    release?.();

    expect(service.beginStream()).toBeDefined();
  });
});

/**
 * Unit suite for PushService.publishStream spans.
 *
 * - uses the real WsService with no sessions, so fan-out is skipped not sent
 * - asserts stream/chunk span names, canonical attributes, and redaction
 * - asserts slot exhaustion emits no spans and never fans out
 * - asserts the slot is released on source errors and span export failures.
 */
describe('PushService.publishStream', () => {
  let service: PushService;
  let module: TestingModule | undefined;
  let tracing: InMemoryTracing | undefined;

  /**
   * Builds a testing module with the real PushService/WsService chain.
   *
   * - provider first (via the fixture) so the service tracer delegates to it
   * - tracks the module so it can be closed after each test.
   *
   * @return The compiled push service.
   */
  async function compileReal(): Promise<PushService> {
    module = await Test.createTestingModule({
      providers: [PushService, WsService],
    }).compile();
    return module.get<PushService>(PushService);
  }

  /**
   * Runs a summary stream, mapping rejection to a gRPC status code.
   *
   * - returns -1 when the stream completes instead of rejecting.
   *
   * @param source Summary observable from the service.
   * @return The status code, or -1 when the stream completed.
   */
  async function rejectCode(
    source: Observable<PublishSummary>,
  ): Promise<number> {
    try {
      await lastValueFrom(source);
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

  beforeEach(async () => {
    tracing = await startInMemoryTracing();
    service = await compileReal();
  });

  afterEach(async () => {
    await tracing?.shutdown();
    tracing = undefined;
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('records a stream span plus one child span per chunk', async () => {
    const summary = await lastValueFrom(
      service.publishStream(
        of(
          { clientIds: ['a'], message: 'one' },
          { clientIds: ['b', 'c'], message: 'two' },
        ),
      ),
    );

    expect(summary).toEqual({ received: 2 });
    const spans = tracing?.exporter.getFinishedSpans() ?? [];
    const streams = spans.filter((span) => span.name === PUSH_PUBLISH_SPAN);
    const chunks = spans.filter((span) => span.name === PUSH_CHUNK_SPAN);
    expect(streams).toHaveLength(1);
    expect(chunks).toHaveLength(2);
    expect(streams[0]?.attributes['rpc.system']).toBe('grpc');
    expect(streams[0]?.attributes['rpc.method']).toBe('Publish');
    expect(streams[0]?.attributes['push.received']).toBe(2);
    expect(chunks[0]?.attributes['push.chunk.index']).toBe(0);
    expect(chunks[1]?.attributes['push.chunk.index']).toBe(1);
    expect(chunks[0]?.attributes['push.client.count']).toBe(1);
    expect(chunks[1]?.attributes['push.client.count']).toBe(2);
    expect(typeof chunks[0]?.attributes['push.message.bytes']).toBe('number');
    expect(chunks[0]?.attributes['push.sent.count']).toBe(0);
    expect(chunks[0]?.attributes['push.skipped.count']).toBe(1);
    expect(typeof chunks[0]?.attributes['push.skipped.count']).toBe('number');
  });

  it('never records bodies, ids lists, or tokens in span attributes', async () => {
    await lastValueFrom(
      service.publishStream(
        of({ clientIds: ['alice'], message: 'secret-body' }),
      ),
    );

    const spans = tracing?.exporter.getFinishedSpans() ?? [];
    const serialized = JSON.stringify(spans.map((span) => span.attributes));
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('authorization');
  });

  it('returns zero without fanning out for an empty stream', async () => {
    const summary = await lastValueFrom(service.publishStream(of()));

    expect(summary).toEqual({ received: 0 });
    const spans = tracing?.exporter.getFinishedSpans() ?? [];
    expect(
      spans.filter((span) => span.name === PUSH_PUBLISH_SPAN),
    ).toHaveLength(1);
    expect(spans.filter((span) => span.name === PUSH_CHUNK_SPAN)).toHaveLength(
      0,
    );
  });

  it('rejects with RESOURCE_EXHAUSTED when no stream slot is free', async () => {
    const releases: Array<() => void> = [];
    for (let index = 0; index < MAX_CONCURRENT_STREAMS; index += 1) {
      const release = service.beginStream();
      if (release !== undefined) {
        releases.push(release);
      }
    }

    const code = await rejectCode(
      service.publishStream(of({ clientIds: ['a'], message: 'one' })),
    );

    expect(code).toBe(status.RESOURCE_EXHAUSTED);
    expect(tracing?.exporter.getFinishedSpans()).toHaveLength(0);
    releases.forEach((release) => release());
  });

  it('marks the stream span ERROR and releases the slot on source errors', async () => {
    const boom = new Error('boom');
    const outcome = await lastValueFrom(
      service.publishStream(
        concat(
          of({ clientIds: ['a'], message: 'one' }),
          throwError(() => boom),
        ),
      ),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    expect(outcome.error).toBe(boom);
    const spans = tracing?.exporter.getFinishedSpans() ?? [];
    const streams = spans.filter((span) => span.name === PUSH_PUBLISH_SPAN);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(service.beginStream()).toBeDefined();
  });

  it('still releases the stream slot when span export throws', async () => {
    await tracing?.shutdown();
    await module?.close();
    module = undefined;
    const ended: string[] = [];
    const recordingThrower: SpanProcessor = {
      onStart: (): void => undefined,
      onEnd: (span): void => {
        ended.push(span.name);
        if (span.name === PUSH_PUBLISH_SPAN) {
          throw new Error('export boom');
        }
      },
      forceFlush: (): Promise<void> => Promise.resolve(),
      shutdown: (): Promise<void> => Promise.resolve(),
    };
    tracing = await startInMemoryTracing([recordingThrower]);
    service = await compileReal();

    try {
      service
        .publishStream(of({ clientIds: ['a'], message: 'one' }))
        .subscribe();
    } catch {
      // Span export failures must never break the stream teardown path.
    }

    expect(ended).toContain(PUSH_PUBLISH_SPAN);
    expect(service.beginStream()).toBeDefined();
  });
});
