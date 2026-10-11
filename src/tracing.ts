/**
 * Starts traces-only OpenTelemetry with HTTP/Express instrumentation.
 * Enabled by default; redacts sensitive query parameters and excludes health checks.
 */

import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { IncomingMessage } from 'node:http';
import { parseEnvFlag } from './common/env';

/** Default in-compose Jaeger OTLP/gRPC endpoint; keep in sync with compose. */
export const DEFAULT_OTLP_ENDPOINT = 'http://jaeger:4317';

/** Default service name reported to Jaeger. */
export const DEFAULT_SERVICE_NAME = 'nestJS-server';

/**
 * Server query parameters to redact. Includes SDK defaults plus `key`;
 * verify the defaults when upgrading HTTP instrumentation.
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

/** Health endpoint excluded from tracing. */
export const HEALTH_PATH = '/health';

let sdk: NodeSDK | undefined;
let started = false;
let shutdownHookRegistered = false;

/** Parses the default-on `OTEL_ENABLED` flag; unknown values warn and enable tracing. */
export function parseEnabled(value: string | undefined): boolean {
  return parseEnvFlag(value, {
    defaultValue: true,
    warnOnUnknown: true,
    label: 'OTEL_ENABLED',
  });
}

/**
 * Checks whether a URL targets `/health`, with an optional trailing slash.
 *
 * @param url Request URL or path, if known.
 * @return Whether it targets the health endpoint.
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
 * Creates HTTP instrumentation with query redaction and health-check exclusion.
 *
 * @return Configured HTTP instrumentation.
 */
export function buildHttpInstrumentation(): HttpInstrumentation {
  return new HttpInstrumentation({
    ignoreIncomingRequestHook: (request: IncomingMessage) =>
      isHealthRequest(request.url),
    redactedQueryParamsServer: [...REDACTED_QUERY_PARAMS_SERVER],
  });
}

/**
 * Starts tracing once unless disabled; logs startup failures and registers shutdown handlers.
 *
 * @return Nothing; registers the global tracer provider.
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
 * Registers one-time `SIGTERM`/`SIGINT` handlers; logs shutdown failures.
 *
 * @return Nothing; attaches signal handlers.
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
 * Flushes and shuts down tracing, resetting state for re-initialization.
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
 * Reports whether tracing started.
 *
 * @return True after successful initialization.
 */
export function isTracingStarted(): boolean {
  return started;
}
