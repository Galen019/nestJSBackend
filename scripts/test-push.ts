/**
 * CLI client for the client-streaming gRPC push endpoint.
 *
 * - signs its own RS256 test JWT (script acts as the issuer, no IdP needed)
 * - sends it as `authorization: Bearer` call metadata, which the server verifies
 * - accepts client IDs as positional or comma-separated arguments
 * - sends one PublishRequest chunk and closes the stream
 * - prints the server's final PublishSummary
 * - `--no-auth` skips the token to assert the server rejects UNAUTHENTICATED.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Client,
  ClientWritableStream,
  credentials,
  loadPackageDefinition,
  Metadata,
  ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { sign } from 'jsonwebtoken';

const DEFAULT_GRPC_URL = 'localhost:50051';
const DEFAULT_MESSAGE = JSON.stringify({ type: 'PING', source: 'cli' });
const DEFAULT_ISSUER = 'test-issuer';
const DEFAULT_AUDIENCE = 'test-audience';

interface PublishRequest {
  client_ids: string[];
  message: string;
}

interface PublishSummary {
  received: number;
}

interface PushClient extends Client {
  publish(
    callback: (error: ServiceError | null, response?: PublishSummary) => void,
  ): ClientWritableStream<PublishRequest>;
  publish(
    metadata: Metadata,
    callback: (error: ServiceError | null, response?: PublishSummary) => void,
  ): ClientWritableStream<PublishRequest>;
}

interface LoadedPushPackage {
  push: {
    PushService: new (
      address: string,
      channelCredentials: ReturnType<typeof credentials.createInsecure>,
    ) => PushClient;
  };
}

function parseArguments(args: string[]): {
  clientIds: string[];
  message: string;
} {
  let message = DEFAULT_MESSAGE;
  const clientIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-auth') {
      continue;
    }
    if (argument === '--message') {
      const nextArgument = args[index + 1];
      if (nextArgument === undefined || nextArgument.startsWith('--')) {
        throw new Error('--message requires a value');
      }
      message = nextArgument;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    for (const clientId of argument.split(',')) {
      const trimmed = clientId.trim();
      if (trimmed.length > 0) {
        clientIds.push(trimmed);
      }
    }
  }

  if (clientIds.length === 0) {
    throw new Error('Provide at least one clientId');
  }

  return { clientIds, message };
}

function loadPushClient(grpcUrl: string): PushClient {
  const protoPath = resolve(process.cwd(), 'proto', 'push.proto');
  const protoSource = readFileSync(protoPath, 'utf8');
  const packageDefinition = loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = loadPackageDefinition(
    packageDefinition,
  ) as unknown as LoadedPushPackage;

  if (!protoSource.includes('service PushService')) {
    throw new Error(`PushService was not found in ${protoPath}`);
  }

  return new loaded.push.PushService(grpcUrl, credentials.createInsecure());
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
 * Signs a short-lived RS256 probe token and wraps it as call metadata.
 *
 * @param privateKey PEM-encoded private key of the test issuer.
 * @return Metadata carrying the `authorization: Bearer` entry.
 */
function signAuthMetadata(privateKey: string): Metadata {
  const token = sign({}, privateKey, {
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER ?? DEFAULT_ISSUER,
    audience: process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE,
    expiresIn: '5m',
  });
  const metadata = new Metadata();
  metadata.add('authorization', `Bearer ${token}`);
  return metadata;
}

function printUsage(): void {
  console.log(
    'Usage: npx ts-node scripts/test-push.ts <clientId> [clientId,...] [--message <text>] [--no-auth]',
  );
  console.log(
    'Example: npx ts-node scripts/test-push.ts client-1 client-2 --message hello',
  );
}

/**
 * Publishes one chunk and resolves with the server summary.
 *
 * @param client Push client for the Publish endpoint.
 * @param request Single PublishRequest chunk to send.
 * @param metadata Call metadata carrying the probe JWT, if any.
 * @return The server's PublishSummary.
 */
function publish(
  client: PushClient,
  request: PublishRequest,
  metadata?: Metadata,
): Promise<PublishSummary> {
  return new Promise((resolvePromise, reject) => {
    const callback = (
      error: ServiceError | null,
      response?: PublishSummary,
    ): void => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (response === undefined) {
        reject(new Error('PushService returned no summary'));
        return;
      }
      resolvePromise(response);
    };
    const stream =
      metadata === undefined
        ? client.publish(callback)
        : client.publish(metadata, callback);

    stream.once('error', reject);
    stream.write(request);
    stream.end();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { clientIds, message } = parseArguments(args);
  const grpcUrl = process.env.GRPC_URL ?? DEFAULT_GRPC_URL;
  const client = loadPushClient(grpcUrl);
  const metadata = args.includes('--no-auth')
    ? undefined
    : signAuthMetadata(readPrivateKey());

  try {
    console.log(`Sending message to ${clientIds.length} client(s)`);
    const summary = await publish(
      client,
      {
        client_ids: clientIds,
        message,
      },
      metadata,
    );
    console.log(`Server received ${summary.received} chunk(s)`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
