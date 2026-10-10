/**
 * Unit suite for the tracing bootstrap.
 *
 * - enable toggle (defaults, explicit values, garbage warns and stays enabled)
 * - health-request matching for the HTTP ignore hook
 * - HTTP instrumentation redacts the `key` query param on server spans
 * - metrics endpoint resolution (defaults, trims, falls back on blank)
 * - disabled `initTracing` stays a noop and never starts the SDK.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_METRICS_INTERVAL_MS,
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_OTLP_METRICS_ENDPOINT,
  DEFAULT_SERVICE_NAME,
  REDACTED_QUERY_PARAMS_SERVER,
  buildHttpInstrumentation,
  initTracing,
  isHealthRequest,
  isTracingStarted,
  parseEnabled,
  resolveMetricsEndpoint,
  shutdownTracing,
} from './tracing';

describe('tracing enabled toggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is enabled by default', () => {
    expect(parseEnabled(undefined)).toBe(true);
    expect(parseEnabled('')).toBe(true);
    expect(parseEnabled('true')).toBe(true);
    expect(parseEnabled('1')).toBe(true);
    expect(parseEnabled('yes')).toBe(true);
  });

  it('is disabled by explicit values', () => {
    expect(parseEnabled('false')).toBe(false);
    expect(parseEnabled('FALSE')).toBe(false);
    expect(parseEnabled('0')).toBe(false);
    expect(parseEnabled('no')).toBe(false);
  });

  it('warns and stays enabled on garbage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseEnabled('bogus')).toBe(true);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('bogus');
  });
});

describe('tracing query redaction', () => {
  it('redacts the redis key param on top of the SDK defaults', () => {
    expect(REDACTED_QUERY_PARAMS_SERVER).toContain('key');
    expect(REDACTED_QUERY_PARAMS_SERVER).toEqual(
      expect.arrayContaining([
        'sig',
        'Signature',
        'AWSAccessKeyId',
        'X-Goog-Signature',
        'X-Amz-Signature',
        'X-Amz-Credential',
        'X-Amz-Security-Token',
      ]),
    );
  });

  it('wires the redaction list and the health hook into the instrumentation', () => {
    const config = buildHttpInstrumentation().getConfig();

    expect(config.redactedQueryParamsServer).toEqual([
      ...REDACTED_QUERY_PARAMS_SERVER,
    ]);
    expect(typeof config.ignoreIncomingRequestHook).toBe('function');
  });
});

describe('tracing health exclusion', () => {
  it('matches /health with query, fragment, or trailing slash', () => {
    expect(isHealthRequest('/health')).toBe(true);
    expect(isHealthRequest('/health?full=1')).toBe(true);
    expect(isHealthRequest('/health/')).toBe(true);
    expect(isHealthRequest('/health/#frag')).toBe(true);
  });

  it('rejects other routes and odd input', () => {
    expect(isHealthRequest('/')).toBe(false);
    expect(isHealthRequest('/redis?key=a')).toBe(false);
    expect(isHealthRequest('/healthz')).toBe(false);
    expect(isHealthRequest('/api/health')).toBe(false);
    expect(isHealthRequest(undefined)).toBe(false);
    expect(isHealthRequest('')).toBe(false);
    expect(isHealthRequest(':::')).toBe(false);
  });
});

describe('tracing lifecycle', () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    await shutdownTracing();
  });

  it('stays unstarted and noop when OTEL_ENABLED=false', async () => {
    process.env.OTEL_ENABLED = 'false';
    initTracing();
    expect(isTracingStarted()).toBe(false);
    await shutdownTracing();
    expect(isTracingStarted()).toBe(false);
  });

  it('keeps the documented endpoint and service defaults', () => {
    expect(DEFAULT_OTLP_ENDPOINT).toBe('http://jaeger:4317');
    expect(DEFAULT_OTLP_METRICS_ENDPOINT).toBe(
      'http://prometheus:9090/api/v1/otlp/v1/metrics',
    );
    expect(DEFAULT_METRICS_INTERVAL_MS).toBe(15000);
    expect(DEFAULT_SERVICE_NAME).toBe('nestJS-server');
  });

  it('resolves the metrics endpoint with trim and fallback', () => {
    expect(resolveMetricsEndpoint(undefined)).toBe(
      DEFAULT_OTLP_METRICS_ENDPOINT,
    );
    expect(resolveMetricsEndpoint('')).toBe(DEFAULT_OTLP_METRICS_ENDPOINT);
    expect(resolveMetricsEndpoint('   ')).toBe(DEFAULT_OTLP_METRICS_ENDPOINT);
    expect(
      resolveMetricsEndpoint('  http://custom:9090/api/v1/otlp/v1/metrics  '),
    ).toBe('http://custom:9090/api/v1/otlp/v1/metrics');
  });

  it('starts the SDK with metrics wired when enabled', () => {
    process.env.OTEL_ENABLED = 'true';
    initTracing();
    expect(isTracingStarted()).toBe(true);
  });
});
