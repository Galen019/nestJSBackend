/**
 * k6 load test for the authenticated Redis REST endpoints.
 *
 * - signs an RS256 test JWT in setup() using the committed test private key
 * - exercises only the success path: POST /redis then GET /redis
 * - checks 200 responses and that the value round-trips through Redis
 *
 * Usage (from the repository root):
 *   k6 run scripts/k6-redis.js
 *   k6 run --vus 20 --duration 1m scripts/k6-redis.js
 *
 * Optional environment variables:
 *   API_URL, JWT_ISSUER, JWT_AUDIENCE, TOKEN_TTL_SECONDS,
 *   KEY_PREFIX, VALUE, THINK_TIME_SECONDS
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { b64decode, b64encode } from 'k6/encoding';

const apiUrl = __ENV.API_URL ?? 'http://localhost:3000';
const issuer = __ENV.JWT_ISSUER ?? 'test-issuer';
const audience = __ENV.JWT_AUDIENCE ?? 'test-audience';
const tokenTtlSeconds = Number(__ENV.TOKEN_TTL_SECONDS ?? 3600);
const keyPrefix = __ENV.KEY_PREFIX ?? 'k6-load';
const value = __ENV.VALUE ?? 'hello-redis';
const thinkTimeSeconds = Number(__ENV.THINK_TIME_SECONDS ?? 1);

export const options = {
  vus: Number(__ENV.VUS ?? 10),
  duration: __ENV.DURATION ?? '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

// k6 resolves open() relative to the script or the working directory depending
// on version, so accept either layout for the committed test fixture.
let privateKeyPem;
try {
  privateKeyPem = open('test/fixtures/test-private.pem');
} catch {
  privateKeyPem = open('../test/fixtures/test-private.pem');
}

/**
 * Reads a top-level JSON field from a response without failing the iteration.
 *
 * @param response Response returned by k6.
 * @param field Name of the field to read.
 * @return Field value, or undefined when the body is not a JSON object.
 */
function jsonField(response, field) {
  try {
    const body = response.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }
    return body[field];
  } catch {
    return undefined;
  }
}

/**
 * Signs a short-lived RS256 token with the committed test private key.
 *
 * @param pem PEM-encoded PKCS#8 private key.
 * @param tokenIssuer Issuer claim expected by the API.
 * @param tokenAudience Audience claim expected by the API.
 * @param ttlSeconds Token lifetime in seconds.
 * @return Compact JWT for the Authorization header.
 */
async function signToken(pem, tokenIssuer, tokenAudience, ttlSeconds) {
  const der = b64decode(
    pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'std',
  );
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, [
    'sign',
  ]);

  const now = Math.floor(Date.now() / 1000);
  const header = b64encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'rawurl');
  const payload = b64encode(
    JSON.stringify({
      iss: tokenIssuer,
      aud: tokenAudience,
      iat: now,
      exp: now + ttlSeconds,
    }),
    'rawurl',
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64encode(signature, 'rawurl')}`;
}

/**
 * Signs one token before VUs start so signing cost stays out of the measurements.
 *
 * @return Setup data containing the token shared by all VUs.
 */
export async function setup() {
  return {
    token: await signToken(privateKeyPem, issuer, audience, tokenTtlSeconds),
  };
}

/**
 * Writes one entry and reads it back over the authenticated REST endpoints.
 *
 * @param data Setup data containing the signed token.
 */
export default function (data) {
  const key = `${keyPrefix}-${__VU}-${__ITER}`;
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };

  const written = http.post(
    `${apiUrl}/redis`,
    JSON.stringify({ key, value }),
    { headers },
  );
  check(written, {
    'POST /redis returns 201': (response) => response.status === 201,
    'POST /redis returns OK': (response) => jsonField(response, 'result') === 'OK',
  });

  const read = http.get(`${apiUrl}/redis?key=${encodeURIComponent(key)}`, {
    headers,
  });
  check(read, {
    'GET /redis returns 200': (response) => response.status === 200,
    'GET /redis returns written value':
      (response) => jsonField(response, 'value') === value,
  });

  sleep(thinkTimeSeconds);
}
