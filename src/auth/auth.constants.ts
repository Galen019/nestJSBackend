/**
 * JWT verification config for RS256.
 *
 * Single source of truth for issuer, audience, and public key.
 * Test code signs with the private key; the API verifies it here.
 * Fail closed on missing or malformed values.
 * The public key is cached per resolved path.
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
 * PEM cache keyed by resolved path.
 */
const publicKeyCache = new Map<string, string>();

/**
 * Read the JWT public key from env.
 *
 * Relative paths resolve from the working directory; prefer absolute paths
 * when the launch directory can vary. Cached per resolved path.
 *
 * @return The PEM-encoded public key.
 */
function readPublicKey(): string {
  const keyPath = process.env.JWT_PUBLIC_KEY_PATH;
  if (keyPath === undefined || keyPath === '') {
    throw new Error('Missing JWT_PUBLIC_KEY_PATH environment variable');
  }
  const resolvedPath = resolve(keyPath);
  const cached = publicKeyCache.get(resolvedPath);
  if (cached !== undefined) {
    return cached;
  }
  let contents: string;
  try {
    contents = readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read JWT public key at "${resolvedPath}" ` +
        `(working directory "${process.cwd()}")`,
    );
  }
  publicKeyCache.set(resolvedPath, contents);
  return contents;
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
