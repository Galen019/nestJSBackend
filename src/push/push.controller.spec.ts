/**
 * Unit suite for PushController streaming adapter.
 *
 * - mocks PushService.publishStream and the JWT verifier
 * - asserts auth rejections never reach the service
 * - asserts valid streams delegate to the service untouched.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import type { Observable } from 'rxjs';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { PushController } from './push.controller';
import { PushService, type PublishSummary } from './push.service';

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
  let publishStream: ReturnType<typeof vi.fn>;
  let verifyHeader: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with a mocked PushService and verifier.
   *
   * - verifier accepts `Bearer good` and rejects everything else
   * - fresh mocks per test so call counts never leak
   * - tracks the module so it can be closed after each test.
   *
   * @return The compiled push controller.
   */
  async function compile(): Promise<PushController> {
    publishStream = vi.fn((source: Observable<unknown>) => source);
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
          useValue: { publishStream },
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

  it('delegates valid streams to the service untouched', async () => {
    publishStream.mockReturnValue(of({ received: 2 }));
    const messages = of(
      { clientIds: ['a'], message: 'one' },
      { clientIds: ['b'], message: 'two' },
    );

    const summary = await lastValueFrom(
      controller.publish(messages, metadataWith('Bearer good')),
    );

    expect(publishStream).toHaveBeenCalledTimes(1);
    expect(publishStream).toHaveBeenCalledWith(messages);
    expect(summary).toEqual({ received: 2 });
  });

  it('rejects with UNAUTHENTICATED when metadata is missing', async () => {
    const code = await rejectCode(
      controller.publish(of({ clientIds: ['a'], message: 'one' })),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(publishStream).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED on an invalid token', async () => {
    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith('Bearer bad'),
      ),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(publishStream).not.toHaveBeenCalled();
  });

  it('rejects with UNAUTHENTICATED when the entry is absent', async () => {
    const code = await rejectCode(
      controller.publish(
        of({ clientIds: ['a'], message: 'one' }),
        metadataWith(),
      ),
    );

    expect(code).toBe(status.UNAUTHENTICATED);
    expect(publishStream).not.toHaveBeenCalled();
  });
});
