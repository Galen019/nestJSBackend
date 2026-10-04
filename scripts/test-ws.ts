/**
 * Test script for the WebSocket server with JWT auth.
 *
 * - signs its own RS256 test JWT (script acts as the issuer, no IdP needed)
 * - connects with `userId`/`clientId`/`token` and fails on unexpected closes
 * - `--no-auth` skips the token to assert the server rejects with 1008.
 *
 * Usage: npx ts-node --transpile-only scripts/test-ws.ts [endpoint] <userId> <clientId> [--no-auth]
 * Example: npx ts-node --transpile-only scripts/test-ws.ts ws://localhost:3000/ws user1 client1
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'jsonwebtoken';
import { WebSocket } from 'ws';

const DEFAULT_ISSUER = 'test-issuer';
const DEFAULT_AUDIENCE = 'test-audience';

const positionalArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== '--no-auth');
const endpoint = positionalArgs[0] ?? 'ws://localhost:3000/ws';
const userIdArg = positionalArgs[1];
const clientIdArg = positionalArgs[2];

/**
 * Resolves the required CLI identities passed as positional arguments.
 *
 * @return The user and client ids to bind the probe token and query to.
 */
function requireArgs(): { userId: string; clientId: string } {
  if (
    userIdArg === undefined ||
    userIdArg === '' ||
    clientIdArg === undefined ||
    clientIdArg === ''
  ) {
    throw new Error(
      'Missing required <userId> <clientId> arguments. Usage: npx ts-node --transpile-only scripts/test-ws.ts [endpoint] <userId> <clientId> [--no-auth]',
    );
  }
  return { userId: userIdArg, clientId: clientIdArg };
}

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
 * Signs a short-lived RS256 probe token bound to the given user.
 *
 * @param privateKey PEM-encoded private key of the test issuer.
 * @param userId Subject the token is bound to, must match the query `userId`.
 * @return The compact JWT.
 */
function signProbeToken(privateKey: string, userId: string): string {
  return sign({ sub: userId }, privateKey, {
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER ?? DEFAULT_ISSUER,
    audience: process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE,
    expiresIn: '5m',
  });
}

/**
 * Opens a client connection that fails fast on unexpected server closes.
 *
 * - resolves when the socket opens
 * - marks process failure when the server closes before we asked it to,
 *   unless `expectClose` is set for negative probes.
 *
 * @param url Full `/ws` URL including query params.
 * @param label Probe step name for log messages.
 * @param expectClose Whether the server is expected to close this socket.
 * @return The open client socket plus a `closeIntentionally` helper.
 */
function connect(
  url: string,
  label: string,
  expectClose = false,
): Promise<{
  socket: WebSocket;
  closeIntentionally: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let intentional = false;

    socket.once('open', () => {
      resolve({
        socket,
        closeIntentionally: (): void => {
          intentional = true;
          socket.close();
        },
      });
    });
    socket.once('error', reject);
    socket.once('close', (code, reason) => {
      if (!intentional && !expectClose) {
        console.error(
          `FAIL: ${label} closed unexpectedly with ${code} (${reason.toString()})`,
        );
        process.exitCode = 1;
      }
    });
  });
}

/**
 * Waits for a client socket to close.
 *
 * @param socket Socket expected to close.
 * @return The numeric close code.
 */
function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code: number) => {
      resolve(code);
    });
  });
}

/**
 * Pauses the probe while the session stays open.
 *
 * @param milliseconds How long to wait.
 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Asserts a tokenless connection is rejected with 1008.
 *
 * - connects without a token and waits for the server close
 * - throws when the close code differs, so the run fails.
 */
async function probeRejected(): Promise<void> {
  const { userId, clientId } = requireArgs();
  const query = new URLSearchParams({
    userId,
    clientId,
  });
  const url = `${endpoint}?${query.toString()}`;
  console.log(`Connecting without a token: ${endpoint}`);

  const { socket } = await connect(url, 'rejected-probe', true);
  const closeCode = await waitForClose(socket);

  if (closeCode !== 1008) {
    throw new Error(`Expected rejection with 1008, got ${closeCode}`);
  }
  console.log('PASS: tokenless connection rejected with close code 1008');
}

async function main(): Promise<void> {
  const { userId, clientId } = requireArgs();
  const useAuth = !process.argv.includes('--no-auth');

  if (!useAuth) {
    await probeRejected();
    return;
  }

  const query = new URLSearchParams({
    userId,
    clientId,
  });
  query.set('token', signProbeToken(readPrivateKey(), userId));
  const validUrl = `${endpoint}?${query.toString()}`;

  console.log(
    `Connecting to ${endpoint} with userId=${userId} clientId=${clientId}`,
  );
  const { socket, closeIntentionally } = await connect(validUrl, 'session');
  console.log('PASS: authenticated connection opened');

  socket.on('message', (data) => {
    console.log(`Received message: ${data.toString()}`);
  });

  socket.send(JSON.stringify({ type: 'PING' }));
  console.log('PASS: message sent');

  console.log('Waiting 120 seconds before closing the connection');
  await wait(120_000);

  closeIntentionally();
  console.log('Connection closed');
}

main().catch((error: unknown) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
