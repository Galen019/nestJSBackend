/**
 * CLI client for the client-streaming gRPC push endpoint.
 *
 * - accepts client IDs as positional or comma-separated arguments
 * - sends one PublishRequest chunk and closes the stream
 * - prints the server's final PublishSummary
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Client,
  ClientWritableStream,
  credentials,
  loadPackageDefinition,
  ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

const DEFAULT_GRPC_URL = 'localhost:50051';
const DEFAULT_MESSAGE = JSON.stringify({ type: 'PING', source: 'cli' });

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

function printUsage(): void {
  console.log(
    'Usage: npx ts-node scripts/test-push.ts <clientId> [clientId,...] [--message <text>]',
  );
  console.log(
    'Example: npx ts-node scripts/test-push.ts client-1 client-2 --message hello',
  );
}

function publish(
  client: PushClient,
  request: PublishRequest,
): Promise<PublishSummary> {
  return new Promise((resolvePromise, reject) => {
    const stream = client.publish((error, response) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (response === undefined) {
        reject(new Error('PushService returned no summary'));
        return;
      }
      resolvePromise(response);
    });

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

  try {
    console.log(`Sending message to ${clientIds.length} client(s)`);
    const summary = await publish(client, {
      client_ids: clientIds,
      message,
    });
    console.log(`Server received ${summary.received} chunk(s)`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
