/**
 * JWT verification config for RS256.
 *
 * Single source of truth for issuer, audience, and public key.
 * Test code signs with the private key; the API verifies it here.
 * Fail closed on missing or malformed values.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Validated JWT config.
 */
export interface JwtConfig {
  publicKey: string;
  issuer: string;
  audience: string;
}

/**
 * Read the JWT public key from env.
 *
 * Relative paths resolve from the working directory; prefer absolute paths
 * when the launch directory can vary.
 *
 * @return The PEM-encoded public key.
 */
function readPublicKey(): string {
  const keyPath = process.env.JWT_PUBLIC_KEY_PATH;
  if (keyPath === undefined || keyPath === '') {
    throw new Error('Missing JWT_PUBLIC_KEY_PATH environment variable');
  }
  try {
    return readFileSync(keyPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read JWT public key at "${resolve(keyPath)}" ` +
        `(working directory "${process.cwd()}")`,
    );
  }
}

/**
 * Read a required non-blank env value.
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
 * Load and validate the JWT verification config.
 *
 * @return The validated JWT config.
 */
export function getJwtConfig(): JwtConfig {
  const publicKey = readPublicKey();
  if (!publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('Invalid JWT public key: expected PEM public key');
  }
  return {
    publicKey,
    issuer: readRequired('JWT_ISSUER'),
    audience: readRequired('JWT_AUDIENCE'),
  };
}
