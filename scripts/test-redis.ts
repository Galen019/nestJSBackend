/**
 * CLI probe for the authenticated Redis REST endpoints.
 *
 * - signs its own RS256 test JWT (script acts as the issuer, no IdP needed)
 * - writes one entry via POST /redis, reads it back via GET /redis
 * - asserts unauthenticated writes are rejected with 401.
 *
 * Usage: npx ts-node scripts/test-redis.ts [key] [value]
 * Example: npx ts-node scripts/test-redis.ts probe-1 hello
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'jsonwebtoken';

const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_KEY = `probe-${Date.now()}`;
const DEFAULT_VALUE = 'hello-redis';
const DEFAULT_ISSUER = 'test-issuer';
const DEFAULT_AUDIENCE = 'test-audience';

/**
 * Reads the test private key used to sign the probe JWT.
 *
 * @return The PEM-encoded private key.
 */
function readPrivateKey(): string {
  const keyPath =
    process.env.TEST_PRIVATE_KEY_PATH ??
    join(process.cwd(), 'test', 'fixtures', 'test-private.pem');
  return readFileSync(keyPath, 'utf8');
}

/**
 * Signs a short-lived RS256 probe token.
 *
 * @param privateKey PEM-encoded private key of the test issuer.
 * @param issuer Expected `iss` claim of the API.
 * @param audience Expected `aud` claim of the API.
 * @return The compact JWT.
 */
function signProbeToken(
  privateKey: string,
  issuer: string,
  audience: string,
): string {
  return sign({}, privateKey, {
    algorithm: 'RS256',
    issuer,
    audience,
    expiresIn: '5m',
  });
}

/**
 * Reads a JSON response body, failing on non-2xx statuses.
 *
 * @param response Fetch response from the API.
 * @param label Probe step name for error messages.
 * @return The parsed JSON body.
 */
async function readJsonBody(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) {
    throw new Error(`${label} returned a non-object body`);
  }
  return body as Record<string, unknown>;
}

/**
 * Writes one entry and reads it back over the authenticated REST endpoints.
 *
 * @param apiUrl Base URL of the running API.
 * @param token Probe JWT signed by this script.
 * @param key Redis key to write.
 * @param value Redis value to write.
 */
async function probeWriteRead(
  apiUrl: string,
  token: string,
  key: string,
  value: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const written = await readJsonBody(
    await fetch(`${apiUrl}/redis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, value }),
    }),
    'POST /redis',
  );
  if (written['result'] !== 'OK') {
    throw new Error(`POST /redis returned result ${String(written['result'])}`);
  }
  console.log(`PASS: wrote key="${key}" value="${value}"`);

  const entry = await readJsonBody(
    await fetch(`${apiUrl}/redis?key=${encodeURIComponent(key)}`, { headers }),
    'GET /redis',
  );
  if (entry['value'] !== value) {
    throw new Error(
      `GET /redis returned value ${String(entry['value'])}, expected ${value}`,
    );
  }
  console.log(`PASS: read back key="${key}" value="${entry['value']}"`);
}

/**
 * Asserts the API rejects an unauthenticated write with 401.
 *
 * @param apiUrl Base URL of the running API.
 * @param key Redis key to attempt writing.
 */
async function probeUnauthorized(apiUrl: string, key: string): Promise<void> {
  const response = await fetch(`${apiUrl}/redis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: 'should-not-persist' }),
  });
  if (response.status !== 401) {
    throw new Error(
      `Expected unauthenticated POST /redis to return 401, got ${response.status}`,
    );
  }
  console.log('PASS: unauthenticated write rejected with 401');
}

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? DEFAULT_API_URL;
  const key = process.argv[2] ?? DEFAULT_KEY;
  const value = process.argv[3] ?? DEFAULT_VALUE;
  const issuer = process.env.JWT_ISSUER ?? DEFAULT_ISSUER;
  const audience = process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE;

  const token = signProbeToken(readPrivateKey(), issuer, audience);
  console.log(`Probing ${apiUrl} as issuer="${issuer}"`);

  await probeWriteRead(apiUrl, token, key, value);
  await probeUnauthorized(apiUrl, key);
  console.log('All Redis REST probes passed');
}

main().catch((error: unknown) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
