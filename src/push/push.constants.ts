/**
 * gRPC push transport constants.
 *
 * - Single source of truth for fan-out caps and connection config
 * - Keeps proto resolution working from both `src/` (dev) and `dist/` (prod).
 */

import { join } from 'node:path';

/** Maximum `clientIds` honored per `PublishRequest`, extras are dropped with a warning. */
export const MAX_CLIENT_IDS = 1000;

/** Maximum characters accepted for the opaque message payload. */
export const MAX_MESSAGE_CHARS = 65536;

/** Maximum chunks accepted per `Publish` stream, further chunks end the RPC. */
export const MAX_CHUNKS_PER_STREAM = 1000;

/** Maximum total `clientIds` accepted per `Publish` stream, excess ends the RPC. */
export const MAX_TOTAL_CLIENT_IDS_PER_STREAM = 10000;

/** Maximum bytes of one chunk message, oversized chunks end the RPC. */
export const MAX_MESSAGE_BYTES = 262144;

/** Maximum total message bytes accepted per `Publish` stream, excess ends the RPC. */
export const MAX_TOTAL_MESSAGE_BYTES_PER_STREAM = 1048576;

/** Maximum wall-clock milliseconds one `Publish` stream may stay open. */
export const MAX_STREAM_DURATION_MS = 60000;

/** Maximum concurrent `Publish` streams, further streams are rejected. */
export const MAX_CONCURRENT_STREAMS = 100;

/** gRPC service package declared in `proto/push.proto`. */
export const PUSH_PACKAGE = 'push';

/** gRPC service name declared in `proto/push.proto`. */
export const PUSH_SERVICE = 'PushService';

/** gRPC method name for the client-streaming fan-out. */
export const PUBLISH_METHOD = 'Publish';

/**
 * gRPC bind address, override with `GRPC_URL` in compose/k8s.
 *
 * - defaults to all interfaces on port 50051
 * - plaintext cluster-internal, no TLS by design.
 *
 * @return The URL to bind the gRPC microservice to.
 */
export function getGrpcUrl(): string {
  return process.env.GRPC_URL ?? '0.0.0.0:50051';
}

/**
 * Resolves the proto file from the process working directory.
 *
 * - works in dev (`cwd` is repo root) and prod (`WORKDIR /app` with `proto/` copied)
 * - override with `GRPC_PROTO_PATH` for custom layouts.
 *
 * @return Absolute path to `push.proto`.
 */
export function getProtoPath(): string {
  return (
    process.env.GRPC_PROTO_PATH ?? join(process.cwd(), 'proto', 'push.proto')
  );
}
