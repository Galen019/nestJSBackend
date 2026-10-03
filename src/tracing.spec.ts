/**
 * Unit suite for tracing bootstrap helpers.
 *
 * - pure config parsing (defaults, overrides, blank handling, enable toggle)
 * - sampler parsing (names, ratio arg, unknown-name fallback)
 * - health-request matching for the HTTP ignore hook
 * - HTTP instrumentation redacts the `key` query param on server spans
 * - disabled `initTracing` stays a noop and never starts the SDK
 * - asserts no forbidden attribute keys (token/authorization/body) are baked in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import {
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_SERVICE_NAME,
  DEFAULT_TRACES_SAMPLER,
  REDACTED_QUERY_PARAMS_SERVER,
  buildHttpInstrumentation,
  buildSampler,
  getTracingConfig,
  initTracing,
  isHealthRequest,
  isTracingStarted,
  parseEnabled,
  parseSamplerArg,
  shouldIgnoreIncomingRequest,
  shutdownTracing,
  type TracingConfig,
} from './tracing';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

/**
 * Builds a minimal incoming-message stand-in for the ignore hook.
 *
 * - only `url` matters to the hook, the rest is never read
 * - avoids hand-rolling a full `IncomingMessage`.
 *
 * @param url Request URL to expose.
 * @return The message stand-in.
 */
function messageWith(url: string): IncomingMessage {
  return { url } as unknown as IncomingMessage;
}

describe('tracing config', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await shutdownTracing();
    vi.restoreAllMocks();
  });

  it('returns code defaults when env is empty', () => {
    const config = getTracingConfig({});
    expect(config).toEqual({
      enabled: true,
      serviceName: DEFAULT_SERVICE_NAME,
      endpoint: DEFAULT_OTLP_ENDPOINT,
      environment: 'development',
      samplerName: DEFAULT_TRACES_SAMPLER,
      samplerArg: 1,
    });
  });

  it('honors OTEL_SERVICE_NAME, endpoint, and NODE_ENV overrides', () => {
    const config = getTracingConfig({
      OTEL_SERVICE_NAME: '  custom-svc ',
      OTEL_EXPORTER_OTLP_ENDPOINT: ' http://jaeger:4318/v1/traces ',
      NODE_ENV: 'production',
    });
    expect(config.serviceName).toBe('custom-svc');
    expect(config.endpoint).toBe('http://jaeger:4318/v1/traces');
    expect(config.environment).toBe('production');
  });

  it('honors OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG overrides', () => {
    const config = getTracingConfig({
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
    });
    expect(config.samplerName).toBe('traceidratio');
    expect(config.samplerArg).toBe(0.25);
  });

  it('falls back to sampler defaults on blank strings', () => {
    const config = getTracingConfig({
      OTEL_TRACES_SAMPLER: '   ',
      OTEL_TRACES_SAMPLER_ARG: '',
    });
    expect(config.samplerName).toBe(DEFAULT_TRACES_SAMPLER);
    expect(config.samplerArg).toBe(1);
  });

  it('falls back to defaults on blank strings', () => {
    const config = getTracingConfig({
      OTEL_SERVICE_NAME: '   ',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      NODE_ENV: '',
    });
    expect(config.serviceName).toBe(DEFAULT_SERVICE_NAME);
    expect(config.endpoint).toBe(DEFAULT_OTLP_ENDPOINT);
    expect(config.environment).toBe('development');
  });

  it('parses the enabled toggle', () => {
    expect(parseEnabled(undefined)).toBe(true);
    expect(parseEnabled('')).toBe(true);
    expect(parseEnabled('true')).toBe(true);
    expect(parseEnabled('1')).toBe(true);
    expect(parseEnabled('false')).toBe(false);
    expect(parseEnabled('FALSE')).toBe(false);
    expect(parseEnabled('0')).toBe(false);
    expect(parseEnabled('no')).toBe(false);
  });

  it('disables config when OTEL_ENABLED is false', () => {
    expect(getTracingConfig({ OTEL_ENABLED: 'false' }).enabled).toBe(false);
  });
});

/**
 * Builds a tracing config with sampler fields overridden.
 *
 * - keeps the remaining fields at their code defaults
 * - avoids repeating the full config literal in every sampler test.
 *
 * @param samplerName Sampler name to resolve.
 * @param samplerArg Ratio for ratio-based samplers.
 * @return Config with the sampler fields set.
 */
function configWithSampler(samplerName: string, samplerArg = 1): TracingConfig {
  return { ...getTracingConfig({}), samplerName, samplerArg };
}

describe('tracing sampler', () => {
  it('parses the sampler ratio arg', () => {
    expect(parseSamplerArg(undefined)).toBe(1);
    expect(parseSamplerArg('')).toBe(1);
    expect(parseSamplerArg('   ')).toBe(1);
    expect(parseSamplerArg('0.25')).toBe(0.25);
    expect(parseSamplerArg('0')).toBe(0);
    expect(parseSamplerArg('1')).toBe(1);
  });

  it('falls back to 1 on non-numeric or out-of-range ratios', () => {
    expect(parseSamplerArg('half')).toBe(1);
    expect(parseSamplerArg('NaN')).toBe(1);
    expect(parseSamplerArg('-0.1')).toBe(1);
    expect(parseSamplerArg('1.5')).toBe(1);
    expect(parseSamplerArg('Infinity')).toBe(1);
  });

  it('builds each supported sampler', () => {
    expect(buildSampler(configWithSampler('always_on'))).toBeInstanceOf(
      AlwaysOnSampler,
    );
    expect(buildSampler(configWithSampler('always_off'))).toBeInstanceOf(
      AlwaysOffSampler,
    );
    expect(
      buildSampler(configWithSampler('parentbased_always_on')),
    ).toBeInstanceOf(ParentBasedSampler);
    expect(
      buildSampler(configWithSampler('parentbased_always_off')),
    ).toBeInstanceOf(ParentBasedSampler);
    expect(
      buildSampler(configWithSampler('traceidratio', 0.25)),
    ).toBeInstanceOf(TraceIdRatioBasedSampler);
    expect(
      buildSampler(configWithSampler('parentbased_traceidratio', 0.25)),
    ).toBeInstanceOf(ParentBasedSampler);
  });

  it('warns and falls back to parent-based always-on for unknown names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sampler = buildSampler(configWithSampler('jaeger_remote'));

    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('jaeger_remote');
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

  it('wires the redaction list into the HTTP instrumentation config', () => {
    const config = buildHttpInstrumentation().getConfig();

    expect(config.redactedQueryParamsServer).toEqual(
      expect.arrayContaining(['key']),
    );
    expect(config.redactedQueryParamsServer).toEqual([
      ...REDACTED_QUERY_PARAMS_SERVER,
    ]);
  });
});

describe('tracing health exclusion', () => {
  it('matches /health with query or trailing slash', () => {
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
  });

  it('ignore hook delegates to health matching', () => {
    expect(shouldIgnoreIncomingRequest(messageWith('/health'))).toBe(true);
    expect(shouldIgnoreIncomingRequest(messageWith('/redis?key=a'))).toBe(
      false,
    );
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

  it('never bakes forbidden attribute keys into the module source', () => {
    const source = readFileSync(join(__dirname, 'tracing.ts'), 'utf8');
    expect(source).not.toMatch(/['"]authorization['"]/i);
    expect(source).not.toMatch(/['"]token['"]/i);
    expect(source).not.toMatch(/['"]message\.body['"]/i);
    expect(source).not.toMatch(/['"]redis\.value['"]/i);
  });
});
