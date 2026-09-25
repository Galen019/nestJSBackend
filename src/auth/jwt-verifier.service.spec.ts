/**
 * Unit suite for JwtVerifierService (RS256 test-key flow).
 *
 * - test code signs with the private key, the service verifies with the public key
 * - covers valid, expired, wrong iss/aud, wrong alg, and tampered tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { sign } from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { JwtVerifierService, extractBearerToken } from './jwt-verifier.service';

/**
 * Loads the committed test keypair.
 *
 * @return Private and public PEM strings.
 */
function loadTestKeys(): { privateKey: string; publicKey: string } {
  const dir = join(process.cwd(), 'test', 'fixtures');
  return {
    privateKey: readFileSync(join(dir, 'test-private.pem'), 'utf8'),
    publicKey: readFileSync(join(dir, 'test-public.pem'), 'utf8'),
  };
}

describe('JwtVerifierService', () => {
  const saved: Record<string, string | undefined> = {};
  let privateKey = '';
  let verifier: JwtVerifierService;

  beforeEach(() => {
    for (const name of [
      'JWT_PUBLIC_KEY',
      'JWT_PUBLIC_KEY_PATH',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
    ]) {
      saved[name] = process.env[name];
    }
    const keys = loadTestKeys();
    privateKey = keys.privateKey;
    process.env.JWT_PUBLIC_KEY_PATH = join(
      process.cwd(),
      'test',
      'fixtures',
      'test-public.pem',
    );
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-audience';
    verifier = new JwtVerifierService();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('verifies a valid RS256 token with iss/aud/exp', () => {
    const token = sign({ sub: 'user-123' }, privateKey, {
      algorithm: 'RS256',
      issuer: 'test-issuer',
      audience: 'test-audience',
      expiresIn: '1h',
    });

    const payload = verifier.verify(token);

    expect(payload.iss).toBe('test-issuer');
    expect(payload.sub).toBe('user-123');
  });

  it('rejects expired tokens', () => {
    const token = sign({ sub: 'user-123' }, privateKey, {
      algorithm: 'RS256',
      issuer: 'test-issuer',
      audience: 'test-audience',
      expiresIn: '-10s',
    });

    expect(() => verifier.verify(token)).toThrow();
  });

  it('rejects wrong issuer and audience', () => {
    const badIss = sign({}, privateKey, {
      algorithm: 'RS256',
      issuer: 'evil-issuer',
      audience: 'test-audience',
      expiresIn: '1h',
    });
    const badAud = sign({}, privateKey, {
      algorithm: 'RS256',
      issuer: 'test-issuer',
      audience: 'evil-audience',
      expiresIn: '1h',
    });

    expect(() => verifier.verify(badIss)).toThrow();
    expect(() => verifier.verify(badAud)).toThrow();
  });

  it('rejects HS256 alg-confusion tokens', () => {
    const hs = sign({ sub: 'user-123' }, 'test-secret', {
      algorithm: 'HS256',
      issuer: 'test-issuer',
      audience: 'test-audience',
      expiresIn: '1h',
    });

    expect(() => verifier.verify(hs)).toThrow();
  });

  it('rejects tampered signatures', () => {
    const token = sign({ sub: 'user-123' }, privateKey, {
      algorithm: 'RS256',
      issuer: 'test-issuer',
      audience: 'test-audience',
      expiresIn: '1h',
    });
    const tampered = `${token.slice(0, -2)}ab`;

    expect(() => verifier.verify(tampered)).toThrow();
  });

  it('parses Bearer headers case-insensitively and rejects other schemes', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('Token abc')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(() => verifier.verifyHeader(undefined)).toThrow();
    expect(() => verifier.verifyHeader('Token abc')).toThrow();
  });
});
