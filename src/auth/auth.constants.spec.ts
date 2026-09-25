/**
 * Unit suite for JWT config loader.
 *
 * - uses temp PEM files, never the real env
 * - covers path vs inline key, missing values, and bad PEM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getJwtConfig } from './auth.constants';

/** Valid test public key loaded from the committed fixture. */
function fixturePublicKey(): string {
  return readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'test-public.pem'),
    'utf8',
  );
}

describe('getJwtConfig', () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string | undefined;

  beforeEach(() => {
    for (const name of [
      'JWT_PUBLIC_KEY',
      'JWT_PUBLIC_KEY_PATH',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('loads the key from a file path with issuer and audience', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const keyPath = join(dir, 'public.pem');
    writeFileSync(keyPath, fixturePublicKey());
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    const config = getJwtConfig();

    expect(config.issuer).toBe('test-issuer');
    expect(config.audience).toBe('test-audience');
    expect(config.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('loads an inline key and unescapes newlines', () => {
    const inline = fixturePublicKey().replace(/\n/g, '\\n');
    process.env.JWT_PUBLIC_KEY = inline;
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    const config = getJwtConfig();

    expect(config.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(config.publicKey).toContain('\n');
  });

  it('throws when no key is configured', () => {
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    expect(() => getJwtConfig()).toThrow(/JWT_PUBLIC_KEY/);
  });

  it('throws when the key is not a PEM public key', () => {
    process.env.JWT_PUBLIC_KEY = 'not-a-key';
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    expect(() => getJwtConfig()).toThrow(/PEM/);
  });

  it('throws when issuer or audience is missing', () => {
    process.env.JWT_PUBLIC_KEY = fixturePublicKey();

    expect(() => getJwtConfig()).toThrow(/JWT_ISSUER/);

    process.env.JWT_ISSUER = 'test-issuer';
    expect(() => getJwtConfig()).toThrow(/JWT_AUDIENCE/);
  });
});
