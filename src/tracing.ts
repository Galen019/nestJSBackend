/**
 * OpenTelemetry tracing bootstrap (traces-only).
 *
 * - Enabled by default, opt out with `OTEL_ENABLED=false`
 * - Starts `NodeSDK` with the OTLP/gRPC exporter plus HTTP + Express
 *   auto-instrumentation
 * - The SDK resolves `OTEL_TRACES_SAMPLER[_ARG]` natively; only the
 *   service-name default, the endpoint default, and the enabled gate live here
 * - Redacts the `key` query param (plus the SDK defaults) from incoming spans
 * - Exposes `isHealthRequest` and `buildHttpInstrumentation` for unit tests
 * - Manual push spans live in `PushService` via `@opentelemetry/api`
 * - Never captures tokens, Authorization headers, message bodies, Redis keys,
 *   or Redis values.
 */

import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { IncomingMessage } from 'node:http';

/**
 * Default OTLP/gRPC traces endpoint (in-compose Jaeger).
 *
 * - Must stay in sync with the `OTEL_EXPORTER_OTLP_ENDPOINT` default in
 *   `docker-compose.yml`, which documents the same contract
 * - `OTLPTraceExporter` (from `exporter-trace-otlp-grpc`) speaks OTLP/gRPC,
 *   which Jaeger serves on 4317; 4318 is OTLP/HTTP and needs the HTTP exporter
 * - the `http://` scheme selects the exporter's insecure credentials.
 */
export const DEFAULT_OTLP_ENDPOINT = 'http://jaeger:4317';

/** Default service name shown in the Jaeger UI. */
export const DEFAULT_SERVICE_NAME = 'nestJS-server';

/**
 * Query parameter names redacted from incoming (server) span attributes.
 *
 * - `redactedQueryParamsServer` replaces the SDK default list instead of
 *   extending it, so the SDK defaults are repeated here verbatim
 * - `key` is added because `GET /redis?key=<name>` would otherwise export
 *   Redis key names to the collector
 * - pinned to the `@opentelemetry/instrumentation-http` 0.222.0 defaults;
 *   re-check this list when upgrading that package.
 */
export const REDACTED_QUERY_PARAMS_SERVER: readonly string[] = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  'key',
];

/** Health path excluded from auto-instrumentation to avoid scrape noise. */
export const HEALTH_PATH = '/health';

let sdk: NodeSDK | undefined;
let started = false;
let shutdownHookRegistered = false;

/**
 * Parses the `OTEL_ENABLED` toggle.
 *
 * - `undefined`/blank means enabled (code default true, tests force false via env)
 * - `true`/`1`/`yes` mean enabled, `false`/`0`/`no` mean disabled
 * - anything else warns and stays enabled so a typo cannot silently kill
 *   tracing in one environment while it runs in another.
 *
 * @param value Raw env value.
 * @return False only for an explicit disable string.
 */
export function parseEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (
    normalized === '' ||
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'yes'
  ) {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  console.warn(
    `[tracing] unknown OTEL_ENABLED "${value}", defaulting to enabled`,
  );
  return true;
}

/**
 * Checks whether a request URL targets the health endpoint.
 *
 * - matches `/health` with optional query string, fragment, or trailing slash
 * - never throws on missing/odd input, returns false then.
 *
 * @param url Request URL or path, if known.
 * @return True when the URL is a health check.
 */
export function isHealthRequest(url: string | undefined): boolean {
  if (url === undefined || url === '') {
    return false;
  }
  try {
    const path = new URL(url, 'http://localhost').pathname;
    return path === HEALTH_PATH || path === `${HEALTH_PATH}/`;
  } catch {
    return false;
  }
}

/**
 * Builds the HTTP auto-instrumentation with the service's redaction policy.
 *
 * - `key` is redacted so Redis key names never reach the collector
 * - health checks are excluded to avoid scrape noise.
 *
 * @return Configured HTTP instrumentation for `NodeSDK`.
 */
export function buildHttpInstrumentation(): HttpInstrumentation {
  return new HttpInstrumentation({
    ignoreIncomingRequestHook: (request: IncomingMessage) =>
      isHealthRequest(request.url),
    redactedQueryParamsServer: [...REDACTED_QUERY_PARAMS_SERVER],
  });
}

/**
 * Starts the OpenTelemetry SDK once.
 *
 * - no-op when `OTEL_ENABLED` disables tracing or when already started
 * - never throws: exporter/startup failures are logged and the app keeps serving
 * - registers a best-effort shutdown hook for `SIGTERM`/`SIGINT`.
 *
 * @return Nothing, the global tracer provider is registered as a side effect.
 */
export function initTracing(): void {
  if (started) {
    return;
  }
  if (!parseEnabled(process.env.OTEL_ENABLED)) {
    return;
  }
  try {
    const traceExporter = new OTLPTraceExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
        DEFAULT_OTLP_ENDPOINT,
    });
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name':
          process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
        'deployment.environment.name':
          process.env.NODE_ENV?.trim() || 'development',
      }),
      traceExporter,
      instrumentations: [
        buildHttpInstrumentation(),
        new ExpressInstrumentation(),
      ],
    });
    sdk.start();
    started = true;
    registerShutdownHook();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[tracing] failed to start: ${detail}`);
  }
}

/**
 * Registers a best-effort SDK shutdown hook.
 *
 * - runs once per process, shuts down the exporter on `SIGTERM`/`SIGINT`
 * - flush errors are logged, never rethrown.
 *
 * @return Nothing, signal handlers are attached as a side effect.
 */
function registerShutdownHook(): void {
  if (shutdownHookRegistered) {
    return;
  }
  shutdownHookRegistered = true;
  const shutdown = (): void => {
    void shutdownTracing().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[tracing] shutdown failed: ${detail}`);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/**
 * Shuts down the SDK and flushes pending spans.
 *
 * - no-op when tracing never started
 * - resets state so tests can re-initialize.
 *
 * @return Resolves when shutdown completes.
 */
export async function shutdownTracing(): Promise<void> {
  if (!started || sdk === undefined) {
    return;
  }
  const current = sdk;
  sdk = undefined;
  started = false;
  await current.shutdown();
}

/**
 * Reports whether the SDK started in this process.
 *
 * - test hook to assert the enabled/disabled paths.
 *
 * @return True after a successful `initTracing`.
 */
export function isTracingStarted(): boolean {
  return started;
}
