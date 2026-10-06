/**
 * Test suite for canonical env flag and bounded-int parsing.
 *
 * - accepts the `true`/`1`/`yes` truthy set case-insensitively with padding
 * - rejects missing, blank, falsy, and unrecognized values by default
 * - options: default-on gates return their default for absent/unknown input
 *   and warn on unknown only when asked.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseBoundedInt, parseEnvFlag } from './env';

describe('parseEnvFlag', () => {
  it('accepts the truthy set', () => {
    expect(parseEnvFlag('true')).toBe(true);
    expect(parseEnvFlag('TRUE')).toBe(true);
    expect(parseEnvFlag('1')).toBe(true);
    expect(parseEnvFlag('yes')).toBe(true);
    expect(parseEnvFlag('  Yes  ')).toBe(true);
  });

  it('rejects missing, blank, falsy, and unknown values', () => {
    expect(parseEnvFlag(undefined)).toBe(false);
    expect(parseEnvFlag('')).toBe(false);
    expect(parseEnvFlag('   ')).toBe(false);
    expect(parseEnvFlag('false')).toBe(false);
    expect(parseEnvFlag('0')).toBe(false);
    expect(parseEnvFlag('no')).toBe(false);
    expect(parseEnvFlag('bogus')).toBe(false);
  });

  it('returns the configured default for missing, blank, and unknown values', () => {
    expect(parseEnvFlag(undefined, { defaultValue: true })).toBe(true);
    expect(parseEnvFlag('', { defaultValue: true })).toBe(true);
    expect(parseEnvFlag('bogus', { defaultValue: true })).toBe(true);
    expect(parseEnvFlag('bogus', { defaultValue: false })).toBe(false);
  });

  it('warns on unknown values only when asked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseEnvFlag('bogus', {
        defaultValue: true,
        warnOnUnknown: true,
        label: 'OTEL_ENABLED',
      });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('bogus');

      parseEnvFlag('bogus');
      parseEnvFlag('true', { warnOnUnknown: true, label: 'OTEL_ENABLED' });

      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseBoundedInt', () => {
  it('returns the default for missing or empty input', () => {
    expect(
      parseBoundedInt(undefined, {
        defaultValue: 6379,
        min: 1,
        max: 65535,
        label: 'REDIS_PORT',
      }),
    ).toBe(6379);
    expect(
      parseBoundedInt('', {
        defaultValue: 6379,
        min: 1,
        max: 65535,
        label: 'REDIS_PORT',
      }),
    ).toBe(6379);
  });

  it('accepts integers within bounds and without an upper bound', () => {
    expect(
      parseBoundedInt('6380', {
        defaultValue: 6379,
        min: 1,
        max: 65535,
        label: 'REDIS_PORT',
      }),
    ).toBe(6380);
    expect(
      parseBoundedInt('200000000', {
        defaultValue: 2097152,
        min: 1,
        label: 'WS_MAX_PAYLOAD_BYTES',
      }),
    ).toBe(200000000);
  });

  it('rejects non-integer, out-of-range, and non-numeric values', () => {
    for (const raw of ['abc', '0', '1.5', ' ', '2MB']) {
      expect(() =>
        parseBoundedInt(raw, {
          defaultValue: 6379,
          min: 1,
          max: 65535,
          label: 'REDIS_PORT',
        }),
      ).toThrow(`Invalid REDIS_PORT: ${raw}`);
    }
    expect(() =>
      parseBoundedInt('65536', {
        defaultValue: 6379,
        min: 1,
        max: 65535,
        label: 'REDIS_PORT',
      }),
    ).toThrow('Invalid REDIS_PORT: 65536');
  });
});
