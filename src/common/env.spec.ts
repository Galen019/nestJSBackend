/**
 * Test suite for canonical env flag parsing.
 *
 * - accepts the `true`/`1`/`yes` truthy set case-insensitively with padding
 * - rejects missing, blank, falsy, and unrecognized values.
 */
import { describe, it, expect } from 'vitest';
import { parseEnvFlag } from './env';

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
});
