/**
 * JWT env config for RS256 verification.
 *
 * - Single source of truth for issuer, audience, and the public key
 * - Test flow: test code signs with the private key, the API verifies here
 * - Fail-closed: throws when any value is missing or malformed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Verified JWT configuration.
 *
 * - publicKey is the PEM used to verify RS256 signatures
 * - issuer and audience are enforced on every token.
 */
export interface JwtConfig {
  publicKey: string;
  issuer: string;
  audience: string;
}

/**
 * Reads the JWT public key from env.
 *
 * - prefers JWT_PUBLIC_KEY_PATH (file mount, Docker-friendly)
 * - relative paths resolve against the server working directory,
 *   so prefer an absolute path when the launch directory may vary
 * - falls back to JWT_PUBLIC_KEY (PEM string, `\n` sequences unescaped)
 * - throws when neither is set or the value is blank.
 *
 * @return The PEM-encoded public key.
 */
function readPublicKey(): string {
  const keyPath = process.env.JWT_PUBLIC_KEY_PATH;
  if (keyPath !== undefined && keyPath !== '') {
    try {
      return readFileSync(keyPath, 'utf8');
    } catch {
      throw new Error(
        `Cannot read JWT public key at "${resolve(keyPath)}" ` +
          `(working directory "${process.cwd()}")`,
      );
    }
  }
  const raw = process.env.JWT_PUBLIC_KEY;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'Missing JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH environment variable',
    );
  }
  return raw.replace(/\\n/g, '\n');
}

/**
 * Reads a required non-blank env value.
 *
 * - throws when the variable is missing or whitespace-only.
 *
 * @param name Env variable name to read.
 * @return The trimmed value.
 */
function readRequired(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Missing ${name} environment variable`);
  }
  return raw.trim();
}

/**
 * Loads and validates the JWT verification config.
 *
 * - public key must look like a PEM block, issuer/audience non-blank
 * - throws on any problem so the app fails fast instead of running open.
 *
 * @return The validated JWT config.
 */
export function getJwtConfig(): JwtConfig {
  const publicKey = readPublicKey();
  if (!publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('Invalid JWT_PUBLIC_KEY: expected PEM public key');
  }
  return {
    publicKey,
    issuer: readRequired('JWT_ISSUER'),
    audience: readRequired('JWT_AUDIENCE'),
  };
}
