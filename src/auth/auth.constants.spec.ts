/**
 * Unit suite for JWT config loader.
 *
 * - uses temp PEM files, never the real env
 * - covers file-path loading, missing values, and bad PEM
 * - covers key-file caching: read once per path, re-read on a new path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getJwtConfig } from './auth.constants';

/** Counts readFileSync calls that go through the mocked node:fs module. */
const fsReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      fsReads.count += 1;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

/** Valid test public key loaded from the committed fixture. */
function fixturePublicKey(): string {
  return readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'test-public.pem'),
    'utf8',
  );
}

/**
 * Builds a PEM-looking key that differs from the committed fixture.
 *
 * @return A distinct PEM public key block.
 */
function otherPublicKey(): string {
  return '-----BEGIN PUBLIC KEY-----\nother-key-material\n-----END PUBLIC KEY-----\n';
}

describe('getJwtConfig', () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string | undefined;

  beforeEach(() => {
    for (const name of ['JWT_PUBLIC_KEY_PATH', 'JWT_ISSUER', 'JWT_AUDIENCE']) {
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

  it('throws when no key path is configured', () => {
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    expect(() => getJwtConfig()).toThrow(/JWT_PUBLIC_KEY_PATH/);
  });

  it('throws when the key is not a PEM public key', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const keyPath = join(dir, 'public.pem');
    writeFileSync(keyPath, 'not-a-key');
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    expect(() => getJwtConfig()).toThrow(/PEM/);
  });

  it('throws when issuer or audience is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const keyPath = join(dir, 'public.pem');
    writeFileSync(keyPath, fixturePublicKey());
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;

    expect(() => getJwtConfig()).toThrow(/JWT_ISSUER/);

    process.env.JWT_ISSUER = 'test-issuer';
    expect(() => getJwtConfig()).toThrow(/JWT_AUDIENCE/);
  });

  it('reads the key file from disk only once per path', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const keyPath = join(dir, 'public.pem');
    writeFileSync(keyPath, fixturePublicKey());
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    const before = fsReads.count;
    getJwtConfig();
    getJwtConfig();
    getJwtConfig();
    const keyReads = fsReads.count - before;

    expect(keyReads).toBe(1);
  });

  it('reuses the cached key contents after the file changes on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const keyPath = join(dir, 'public.pem');
    writeFileSync(keyPath, fixturePublicKey());
    process.env.JWT_PUBLIC_KEY_PATH = keyPath;
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    const first = getJwtConfig();
    writeFileSync(keyPath, otherPublicKey());
    const second = getJwtConfig();

    expect(second.publicKey).toBe(first.publicKey);
  });

  it('reads a different key path fresh', () => {
    dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const firstPath = join(dir, 'first.pem');
    const secondPath = join(dir, 'second.pem');
    writeFileSync(firstPath, fixturePublicKey());
    writeFileSync(secondPath, otherPublicKey());
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';

    process.env.JWT_PUBLIC_KEY_PATH = firstPath;
    const first = getJwtConfig();
    process.env.JWT_PUBLIC_KEY_PATH = secondPath;
    const second = getJwtConfig();

    expect(first.publicKey).toBe(fixturePublicKey());
    expect(second.publicKey).toBe(otherPublicKey());
  });
});
