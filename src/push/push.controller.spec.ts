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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { concat, lastValueFrom, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { PushController, type PublishSummary } from './push.controller';
import { PushService } from './push.service';

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

  /**
   * Runs a summary stream, mapping rejection to a gRPC status code.
   *
   * - returns -1 when the stream completes instead of rejecting.
   *
   * @param source Summary observable from the controller.
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
