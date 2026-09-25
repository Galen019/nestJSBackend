/**
 * Test-only JWT issuer helper (no real IdP).
 *
 * - Signs RS256 tokens with the committed test private key
 * - The API verifies with `test-public.pem` via `JWT_PUBLIC_KEY_PATH`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign, type Algorithm, type SignOptions } from 'jsonwebtoken';

/**
 * Test JWT issuer and audience values.
 *
 * - Must match `JWT_ISSUER`/`JWT_AUDIENCE` set in the suites.
 */
export const TEST_JWT_ISSUER = 'test-issuer';
export const TEST_JWT_AUDIENCE = 'test-audience';

/**
 * Options for signing a test token.
 *
 * - `expiresIn` accepts jsonwebtoken forms like '1h' or '-10s' for expired tokens
 * - `issuer`/`audience` override the defaults for negative cases
 * - `algorithm` defaults to RS256; HS256 simulates alg-confusion attacks.
 */
export interface SignTestTokenOptions {
  sub?: string;
  expiresIn?: SignOptions['expiresIn'];
  issuer?: string;
  audience?: string;
  algorithm?: Algorithm;
  privateKeyPem?: string;
}

/**
 * Reads the committed test private key.
 *
 * @return The PEM-encoded test private key.
 */
export function readTestPrivateKey(): string {
  return readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'test-private.pem'),
    'utf8',
  );
}

/**
 * Signs a test JWT acting as the issuer.
 *
 * - RS256 uses the committed test private key
 * - HS256 uses a symmetric secret to simulate alg-confusion attacks.
 *
 * @param options Signing options with issuer/audience defaults.
 * @return The compact JWT.
 */
export function signTestToken(options: SignTestTokenOptions = {}): string {
  const algorithm = options.algorithm ?? 'RS256';
  const key =
    options.privateKeyPem ??
    (algorithm === 'HS256' ? 'test-secret' : readTestPrivateKey());
  const payload: Record<string, unknown> = {};
  if (options.sub !== undefined) {
    payload['sub'] = options.sub;
  }
  return sign(payload, key, {
    algorithm: algorithm,
    issuer: options.issuer ?? TEST_JWT_ISSUER,
    audience: options.audience ?? TEST_JWT_AUDIENCE,
    expiresIn: options.expiresIn ?? '1h',
  });
}

/**
 * Builds an Authorization header value for a test token.
 *
 * @param token Compact JWT to wrap.
 * @return The `Bearer <jwt>` header value.
 */
export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}
