/**
 * Test script for the WebSocket server. Connects to the server, sends a message, and waits for a response.
 *
 * - connects to the server with a valid `userId` and `clientId`
 */
import { WebSocket } from 'ws';

const endpoint = process.argv[2] ?? 'ws://localhost:3000/ws';

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);

    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function main(): Promise<void> {
  const clientId = process.argv[3] ?? `cli-client-${Date.now()}`;
  const validUrl = `${endpoint}?userId=test-user&clientId=${clientId}`;

  console.log(`Connecting to ${validUrl} with clientId=${clientId}`);

  const socket = await connect(validUrl);
  console.log('PASS: connection opened');

  socket.on('message', (data) => {
    console.log(`Received message: ${data.toString()}`);
  });

  socket.send(JSON.stringify({ type: 'PING' }));
  console.log('PASS: message sent');

  console.log('Waiting 120 seconds before closing the connection');
  await wait(120_000);

  socket.close();
  console.log('Connection closed');

  const invalidUrl = endpoint;
  console.log(`Testing invalid connection: ${invalidUrl}`);

  const invalidSocket = await connect(invalidUrl);
  const closeCode = await waitForClose(invalidSocket);

  if (closeCode !== 1008) {
    throw new Error(
      `Expected invalid connection to close with 1008, got ${closeCode}`,
    );
  }

  console.log('PASS: missing parameters rejected with close code 1008');
}

main().catch((error: unknown) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});