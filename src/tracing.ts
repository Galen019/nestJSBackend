/**
 * OpenTelemetry tracing bootstrap (traces-only).
 *
 * - Reads `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
 *   `OTEL_TRACES_SAMPLER`, and `OTEL_TRACES_SAMPLER_ARG`
 * - Starts `NodeSDK` with OTLP/HTTP exporter plus HTTP + Express auto-instrumentation
 * - Redacts the `key` query param (plus the SDK defaults) from incoming spans
 * - Exposes pure helpers (`getTracingConfig`, `buildSampler`, `isHealthRequest`)
 *   for unit tests
 * - Manual WS/gRPC spans live in `WsService`/`PushController` via `@opentelemetry/api`
 * - Never captures tokens, Authorization headers, message bodies, Redis keys,
 *   or Redis values.
 */

import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from '@opentelemetry/sdk-trace';
import type { IncomingMessage } from 'node:http';

/** Default OTLP/HTTP traces endpoint (in-compose Jaeger). */
export const DEFAULT_OTLP_ENDPOINT = 'http://jaeger:4318/v1/traces';

/** Default service name shown in the Jaeger UI. */
export const DEFAULT_SERVICE_NAME = 'nestJS-server';

/** Default sampler when `OTEL_TRACES_SAMPLER` is unset or unknown. */
export const DEFAULT_TRACES_SAMPLER = 'parentbased_always_on';

/** Default trace-id ratio when `OTEL_TRACES_SAMPLER_ARG` is missing or invalid. */
export const DEFAULT_SAMPLER_ARG = 1;

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

/**
 * Resolved tracing configuration.
 *
 * - `enabled` gates `initTracing` startup
 * - `serviceName` becomes the Jaeger service name
 * - `endpoint` is the full OTLP/HTTP traces URL
 * - `environment` comes from `NODE_ENV` for the deployment attribute
 * - `samplerName`/`samplerArg` come from `OTEL_TRACES_SAMPLER[_ARG]`.
 */
export interface TracingConfig {
  enabled: boolean;
  serviceName: string;
  endpoint: string;
  environment: string;
  samplerName: string;
  samplerArg: number;
}

let sdk: NodeSDK | undefined;
let started = false;
let shutdownHookRegistered = false;

/**
 * Parses the `OTEL_ENABLED` toggle.
 *
 * - `undefined`/blank means enabled (code default true, tests force false via env)
 * - `false`/`0`/`no` (case-insensitive, trimmed) mean disabled.
 *
 * @param value Raw env value.
 * @return False when the value is an explicit disable string.
 */
export function parseEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '') {
    return true;
  }
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no';
}

/**
 * Resolves tracing config from the environment.
 *
 * - reads `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
 *   `NODE_ENV`, `OTEL_TRACES_SAMPLER`, and `OTEL_TRACES_SAMPLER_ARG`
 * - trims values, falls back to code defaults on blank input.
 *
 * @param env Environment record, defaults to `process.env`.
 * @return Resolved tracing configuration.
 */
export function getTracingConfig(
  env: NodeJS.ProcessEnv = process.env,
): TracingConfig {
  return {
    enabled: parseEnabled(env.OTEL_ENABLED),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || DEFAULT_OTLP_ENDPOINT,
    environment: env.NODE_ENV?.trim() || 'development',
    samplerName: env.OTEL_TRACES_SAMPLER?.trim() || DEFAULT_TRACES_SAMPLER,
    samplerArg: parseSamplerArg(env.OTEL_TRACES_SAMPLER_ARG),
  };
}

/**
 * Parses the `OTEL_TRACES_SAMPLER_ARG` ratio for ratio-based samplers.
 *
 * - mirrors the SDK range contract: a number in `[0, 1]`
 * - blank, non-numeric, or out-of-range input falls back to 1 (keep all).
 *
 * @param value Raw env value.
 * @return The ratio to sample, defaulting to 1.
 */
export function parseSamplerArg(value: string | undefined): number {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return DEFAULT_SAMPLER_ARG;
  }
  const ratio = Number(trimmed);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return DEFAULT_SAMPLER_ARG;
  }
  return ratio;
}

/**
 * Builds the SDK sampler named by the tracing config.
 *
 * - resolves `OTEL_TRACES_SAMPLER` explicitly so the compose knob never depends
 *   on implicit SDK env handling that a future upgrade could change
 * - unknown names warn and fall back to the default (parent-based always-on),
 *   matching the SDK's own fallback.
 *
 * @param config Resolved tracing configuration.
 * @return The sampler to hand to `NodeSDK`.
 */
export function buildSampler(config: TracingConfig): Sampler {
  switch (config.samplerName) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(config.samplerArg);
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.samplerArg),
      });
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    default:
      console.warn(
        `[tracing] unknown OTEL_TRACES_SAMPLER "${config.samplerName}", ` +
          `defaulting to "${DEFAULT_TRACES_SAMPLER}"`,
      );
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

/**
 * Checks whether a request URL targets the health endpoint.
 *
 * - matches `/health` with optional query string or trailing slash
 * - never throws on missing/odd input, returns false then.
 *
 * @param url Request URL or path, if known.
 * @return True when the URL is a health check.
 */
export function isHealthRequest(url: string | undefined): boolean {
  if (url === undefined || url === '') {
    return false;
  }
  const path = url.split('?')[0].split('#')[0];
  return path === HEALTH_PATH || path === `${HEALTH_PATH}/`;
}

/**
 * Ignore hook for HTTP auto-instrumentation.
 *
 * - keeps `GET /health` (and its Redis ping) out of Jaeger.
 *
 * @param request Incoming Node HTTP request.
 * @return True when the request should not produce a span.
 */
export function shouldIgnoreIncomingRequest(request: IncomingMessage): boolean {
  return isHealthRequest(request.url);
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
    ignoreIncomingRequestHook: shouldIgnoreIncomingRequest,
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
  const config = getTracingConfig();
  if (!config.enabled) {
    return;
  }
  try {
    const traceExporter = new OTLPTraceExporter({ url: config.endpoint });
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': config.serviceName,
        'deployment.environment.name': config.environment,
      }),
      sampler: buildSampler(config),
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
