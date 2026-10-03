/**
 * Unit suite for PushController streaming adapter.
 *
 * - mocks PushService and JWT verifier, feeds chunks via rxjs `of`
 * - asserts per-chunk delegation plus terminal `{ received }` summary
 * - covers empty streams, slot release, busy rejection, source errors, auth
 * - quota breaches live in `stream-budget.spec.ts`, not here
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { concat, lastValueFrom, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { PushController, type PublishSummary } from './push.controller';
import { PushService } from './push.service';
import { WsService } from '../ws/ws.service';

/**
 * Builds a `Metadata` stand-in carrying one authorization entry.
 *
 * - mirrors the real transport shape (`getMap()` with normalized keys)
 * - omits the entry when no header is given.
 *
 * @param header Raw authorization header value, if any.
 * @return The metadata stand-in.
 */
function metadataWith(header?: string): Metadata {
  const fake = {
    getMap: (): Record<string, string> =>
      header === undefined ? {} : { authorization: header },
  };
  return fake as unknown as Metadata;
}

/**
 * Runs a summary stream, mapping rejection to a gRPC status code.
 *
 * - returns -1 when the stream completes instead of rejecting.
 *
 * @param source Summary observable from the controller.
 * @return The status code, or -1 when the stream completed.
 */
async function rejectCode(source: Observable<PublishSummary>): Promise<number> {
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

describe('PushController', () => {
  let controller: PushController;
  let module: TestingModule | undefined;
  let publishNormalized: ReturnType<typeof vi.fn>;
  let beginStream: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let verifyHeader: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with mocked PushService and verifier.
   *
   * - verifier accepts `Bearer good` and rejects everything else
   * - fresh mocks per test so call counts never leak
   * - the slot handle defaults to an observable release mock
   * - tracks the module so it can be closed after each test.
   *
   * @return The compiled push controller.
   */
  async function compile(): Promise<PushController> {
    publishNormalized = vi.fn();
    release = vi.fn();
    beginStream = vi.fn(() => release);
    verifyHeader = vi.fn((header: unknown) => {
      if (header === 'Bearer good') {
        return { iss: 'test-issuer', aud: 'test-audience', exp: 9999999999 };
      }
      throw new Error('bad token');
    });
    module = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        {
          provide: PushService,
          useValue: { publishNormalized, beginStream },
        },
        {
          provide: JwtVerifierService,
          useValue: { verifyHeader },
        },
      ],
    }).compile();
    return module.get<PushController>(PushController);
  }

  beforeEach(async () => {
    controller = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('publishes each chunk and returns the received count', async () => {
    const summary = await lastValueFrom(
      controller.publish(
        of(
          { clientIds: ['a'], message: 'one' },
          { clientIds: ['b'], message: 'two' },
        ),
        metadataWith('Bearer good'),
      ),
    );

    expect(publishNormalized).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ received: 2 });
  });

  it('returns zero without calling the service for an empty stream', async () => {
    const summary = await lastValueFrom(
      controller.publish(of(), metadataWith('Bearer good')),
    );

    expect(publishNormalized).not.toHaveBeenCalled();
    expect(summary).toEqual({ received: 0 });
  });

  it('releases the stream slot on completion', async () => {
    await lastValueFrom(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer good'),
      ),
    );

    expect(beginStream).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects with RESOURCE_EXHAUSTED when no stream slot is free', async () => {
    beginStream.mockReturnValue(undefined);

    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer good'),
      ),
    );

    expect(code).toBe(status.RESOURCE_EXHAUSTED);
    expect(publishNormalized).not.toHaveBeenCalled();
  });

  it('releases the slot and propagates source errors', async () => {
    const boom = new Error('boom');
    const outcome = await lastValueFrom(
      controller.publish(
        concat(
          of({ clientIds: ['a'], message: 'one' }),
          throwError(() => boom),
        ),
        metadataWith('Bearer good'),
      ),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    expect(outcome.error).toBe(boom);
    expect(publishNormalized).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects with UNAUTHENTICATED when metadata is missing', async () => {
    const code = await rejectCode(
      controller.publish(of({ clientIds: ['a'], message: 'one' })),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(beginStream).not.toHaveBeenCalled();
    expect(publishNormalized).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED on an invalid token', async () => {
    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer bad'),
      ),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(beginStream).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED when the entry is absent', async () => {
    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith(),
      ),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(beginStream).not.toHaveBeenCalled();
  });
});

/**
 * Unit suite for PushController tracing spans.
 *
 * - uses an in-memory OTel provider so spans are captured without an exporter
 * - asserts stream/chunk span names, allowlisted attributes, and redaction
 * - asserts auth/slot rejections emit no spans and never consume slots
 * - asserts the slot is released even when ending the span throws
 * - asserts fan-out `ws.send` spans parent under their `push.chunk` span.
 */
describe('PushController tracing', () => {
  let controller: PushController;
  let module: TestingModule | undefined;
  let provider: BasicTracerProvider | undefined;
  let exporter: InMemorySpanExporter;
  let publishNormalized: ReturnType<typeof vi.fn>;
  let beginStream: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let verifyHeader: ReturnType<typeof vi.fn>;

  /**
   * Registers an in-memory tracer provider, then builds the controller.
   *
   * - verifier accepts `Bearer good` and rejects everything else
   * - fresh exporter per test so finished spans never leak across tests
   * - `processors` overrides the default in-memory sink (throwing-span tests)
   * - `realServices` wires the real PushService/WsService chain (parentage test).
   *
   * @param options Optional processor override and service wiring.
   * @return The compiled push controller.
   */
  async function compileWithTracing(options?: {
    processors?: SpanProcessor[];
    realServices?: boolean;
  }): Promise<PushController> {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: options?.processors ?? [
        new SimpleSpanProcessor(exporter),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    publishNormalized = vi.fn();
    release = vi.fn();
    beginStream = vi.fn(() => release);
    verifyHeader = vi.fn((header: unknown) => {
      if (header === 'Bearer good') {
        return { iss: 'test-issuer', aud: 'test-audience', exp: 9999999999 };
      }
      throw new Error('bad token');
    });
    const pushProvider =
      options?.realServices === true
        ? PushService
        : {
            provide: PushService,
            useValue: { publishNormalized, beginStream },
          };
    module = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        pushProvider,
        WsService,
        {
          provide: JwtVerifierService,
          useValue: { verifyHeader },
        },
      ],
    }).compile();
    return module.get<PushController>(PushController);
  }

  /**
   * Tears down the `beforeEach` tracing module so a test can rebuild it.
   *
   * - shuts down the provider and closes the module before re-registering
   * - the `afterEach` hook still cleans up the rebuilt module.
   *
   * @return Nothing, shared module state is cleared.
   */
  async function resetTracing(): Promise<void> {
    await provider?.shutdown();
    provider = undefined;
    trace.disable();
    await module?.close();
    module = undefined;
  }

  beforeEach(async () => {
    controller = await compileWithTracing();
  });

  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
    trace.disable();
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('records a stream span plus one child span per chunk', async () => {
    const summary = await lastValueFrom(
      controller.publish(
        of(
          { clientIds: ['a'], message: 'one' },
          { clientIds: ['b', 'c'], message: 'two' },
        ),
        metadataWith('Bearer good'),
      ),
    );

    expect(summary).toEqual({ received: 2 });
    const spans = exporter.getFinishedSpans();
    const streams = spans.filter((span) => span.name === 'push.publish');
    const chunks = spans.filter((span) => span.name === 'push.chunk');
    expect(streams).toHaveLength(1);
    expect(chunks).toHaveLength(2);
    expect(streams[0]?.attributes['rpc.system']).toBe('grpc');
    expect(streams[0]?.attributes['rpc.method']).toBe('Publish');
    expect(streams[0]?.attributes['push.received']).toBe(2);
    expect(chunks[0]?.attributes['grpc.chunk.index']).toBe(0);
    expect(chunks[1]?.attributes['grpc.chunk.index']).toBe(1);
    expect(chunks[0]?.attributes['grpc.client_ids.count']).toBe(1);
    expect(chunks[1]?.attributes['grpc.client_ids.count']).toBe(2);
    expect(typeof chunks[0]?.attributes['grpc.message.bytes']).toBe('number');
    const serialized = JSON.stringify(spans.map((span) => span.attributes));
    expect(serialized).not.toContain('Bearer good');
    expect(serialized).not.toContain('authorization');
  });

  it('emits no spans when metadata is missing', async () => {
    const code = await rejectCode(
      controller.publish(of({ clientIds: ['a'], message: 'one' })),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(beginStream).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('emits no spans when no stream slot is free', async () => {
    beginStream.mockReturnValue(undefined);

    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer good'),
      ),
    );

    expect(code).toBe(status.RESOURCE_EXHAUSTED);
    expect(publishNormalized).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('marks the stream span ERROR and releases the slot on source errors', async () => {
    const boom = new Error('boom');
    const outcome = await lastValueFrom(
      controller.publish(
        concat(
          of({ clientIds: ['a'], message: 'one' }),
          throwError(() => boom),
        ),
        metadataWith('Bearer good'),
      ),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    expect(outcome.error).toBe(boom);
    expect(release).toHaveBeenCalledTimes(1);
    const streams = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'push.publish');
    expect(streams).toHaveLength(1);
    expect(streams[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('still releases the stream slot when ending the span throws', async () => {
    await resetTracing();
    const exportBoom = new Error('export boom');
    const ended: string[] = [];
    const recordingThrower: SpanProcessor = {
      onStart: (): void => undefined,
      onEnd: (span): void => {
        ended.push(span.name);
        if (span.name === 'push.publish') {
          throw exportBoom;
        }
      },
      forceFlush: (): Promise<void> => Promise.resolve(),
      shutdown: (): Promise<void> => Promise.resolve(),
    };
    controller = await compileWithTracing({
      processors: [recordingThrower],
    });

    controller
      .publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer good'),
      )
      .subscribe();

    expect(ended).toContain('push.publish');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('parents fan-out ws.send spans under their push.chunk span', async () => {
    await resetTracing();
    controller = await compileWithTracing({ realServices: true });

    const summary = await lastValueFrom(
      controller.publish(
        of({ clientIds: ['push-trace-client'], message: 'hi' }),
        metadataWith('Bearer good'),
      ),
    );

    expect(summary).toEqual({ received: 1 });
    const spans = exporter.getFinishedSpans();
    const chunk = spans.find((span) => span.name === 'push.chunk');
    const send = spans.find((span) => span.name === 'ws.send');
    expect(chunk).toBeDefined();
    expect(send).toBeDefined();
    expect(send?.parentSpanContext?.spanId).toBe(chunk?.spanContext().spanId);
  });
});
