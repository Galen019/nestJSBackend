/**
 * gRPC streaming controller for WS fan-out.
 *
 * - Thin adapter: authenticates the stream, then delegates to `PushService`
 * - Slots, quotas, spans, and fan-out all live in `PushService.publishStream`.
 */

import { Controller } from '@nestjs/common';
import { GrpcStreamMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { PUBLISH_METHOD, PUSH_SERVICE } from './push.constants';
import {
  PushService,
  type PublishRequestGrpc,
  type PublishSummary,
} from './push.service';

/**
 * Client-streaming endpoint `PushService.Publish`.
 *
 * - stays open for many `PublishRequest` chunks over one HTTP/2 stream
 * - each chunk is fanned out independently without replying mid-stream
 * - completes with `{ received }` when the client ends the stream
 * - quota breaches terminate the RPC via `StreamBudget` in the service.
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
   * - verifies `authorization: Bearer <jwt>` metadata first (UNAUTHENTICATED
   *   on failure, before any stream slot is consumed)
   * - otherwise delegates to `PushService.publishStream`.
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
    return this.pushService.publishStream(messages);
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
