/**
 * RS256 JWT verification service.
 *
 * - Verifies signature plus issuer, audience, and expiration
 * - Test flow: tests sign with the private key, this service verifies
 * - Throws on any problem so callers map failures to 401/1008/UNAUTHENTICATED.
 */
import { Injectable } from '@nestjs/common';
import { verify } from 'jsonwebtoken';
import { getJwtConfig } from './auth.constants';

/**
 * Minimal verified JWT payload.
 *
 * - `iss`/`aud`/`exp` are always present after verification
 * - `sub` is optional and used to bind WS `userId` when present.
 */
export interface JwtPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  sub?: string;
}

/**
 * Checks that a decoded value has the required JWT claims.
 *
 * - narrows `unknown` without casts, rejects strings and partial objects.
 *
 * @param value Decoded token payload from `jsonwebtoken`.
 * @return True when the value carries iss, aud, and exp.
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
 * Extracts the token from an `Authorization` header value.
 *
 * - accepts `Bearer <jwt>` case-insensitively with surrounding whitespace
 * - returns undefined for missing or non-Bearer schemes (fail-closed).
 *
 * @param header Raw `Authorization` header value.
 * @return The token, or undefined when the scheme is wrong.
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
 * Verifies RS256 JWTs against the configured public key.
 *
 * - Reads config lazily so tests can set env per suite before verifying
 * - Enforces `RS256` only, rejecting alg-confusion tokens (e.g. HS256).
 */
@Injectable()
export class JwtVerifierService {
  /**
   * Verifies a JWT and returns its payload.
   *
   * - enforces signature, expiration, issuer, and audience
   * - throws when the token is malformed, expired, or has wrong claims.
   *
   * @param token Compact JWT to verify.
   * @return The verified payload.
   */
  verify(token: string): JwtPayload {
    const config = getJwtConfig();
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
   * Extracts and verifies the token from an `Authorization` header.
   *
   * - combines scheme parsing with signature/claims verification
   * - throws when the header is missing, non-Bearer, or invalid.
   *
   * @param header Raw `Authorization` header value.
   * @return The verified payload.
   */
  verifyHeader(header: string | undefined): JwtPayload {
    const token = extractBearerToken(header);
    if (token === undefined) {
      throw new Error('Missing Bearer token');
    }
    return this.verify(token);
  }
}
