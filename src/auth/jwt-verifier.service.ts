/** Verifies RS256 JWT signatures and required claims. */
import { Injectable } from '@nestjs/common';
import { verify } from 'jsonwebtoken';
import { getJwtConfig, type JwtConfig } from './auth.constants';

/** Verified JWT claims. */
export interface JwtPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  sub?: string;
}

/**
 * Checks required JWT claims.
 *
 * @param value Decoded token payload.
 * @return Whether the claims are valid.
 */
function isJwtPayload(value: unknown): value is JwtPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('iss' in value) || !('aud' in value) || !('exp' in value)) {
    return false;
  }
  const candidate = value;
  if (typeof candidate.iss !== 'string' || typeof candidate.exp !== 'number') {
    return false;
  }
  const audOk =
    typeof candidate.aud === 'string' ||
    (Array.isArray(candidate.aud) &&
      candidate.aud.every((entry: unknown) => typeof entry === 'string'));
  return audOk;
}

/**
 * Extracts a Bearer token from an authorization header.
 *
 * - accepts `Bearer <jwt>` case-insensitively with surrounding whitespace
 * - returns undefined for missing or non-Bearer schemes (fail-closed).
 *
 * @param header Authorization header value.
 * @return The token, or undefined if invalid.
 */
export function extractBearerToken(
  header: string | undefined,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = header.match(/^\s*Bearer\s+(.+?)\s*$/i);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const token = match[1].trim();
  return token === '' ? undefined : token;
}

/**
 * Verifies RS256 JWTs using cached configuration.
 */
@Injectable()
export class JwtVerifierService {
  private config: JwtConfig | undefined;

  /**
   * Verifies a JWT's signature and claims.
   *
   * @param token JWT to verify.
   * @return Verified payload.
   */
  verify(token: string): JwtPayload {
    const config = this.getConfig();
    const decoded: unknown = verify(token, config.publicKey, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.audience,
    });
    if (!isJwtPayload(decoded)) {
      throw new Error('Invalid token payload');
    }
    return decoded;
  }

  /**
   * Loads and caches JWT config on first use.
   *
   * - env is still read lazily, so suites can set it before the first verify
   * - a malformed or missing config throws on every call and is never cached
   *
   * @return Cached JWT config.
   */
  private getConfig(): JwtConfig {
    this.config ??= getJwtConfig();
    return this.config;
  }

  /**
   * Extracts and verifies a JWT from an authorization header.
   *
   * @param header Authorization header value.
   * @return Verified payload.
   */
  verifyHeader(header: string | undefined): JwtPayload {
    const token = extractBearerToken(header);
    if (token === undefined) {
      throw new Error('Missing Bearer token');
    }
    return this.verify(token);
  }
}
