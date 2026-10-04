/**
 * Unit suite for the shared Redis lifecycle helpers.
 *
 * - attach: forwards client `error` events to the reporter
 * - connect: resolves on success, throws the last error after exhaustion
 * - quit: quits when open, skips when closed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  attachRedisErrorHandler,
  connectRedisClient,
  quitRedisClient,
} from './redis.lifecycle';

/**
 * Creates a fake lifecycle client with mocked connect/quit/on.
 *
 * @param isOpen Whether the fake reports an open connection.
 * @return Fake client plus its mocks.
 */
function createLifecycleFake(isOpen = false) {
  return {
    isOpen,
    connect: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    quit: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    on: vi
      .fn<(event: string, listener: (err: Error) => void) => unknown>()
      .mockReturnValue(undefined),
  };
}

describe('attachRedisErrorHandler', () => {
  it('forwards client errors to the reporter', () => {
    const client = createLifecycleFake();
    const report = vi.fn<(err: Error) => void>();
    attachRedisErrorHandler(client, report);
    const listener = client.on.mock.calls[0]?.[1];
    if (typeof listener !== 'function') {
      throw new Error('Expected an error listener');
    }

    listener(new Error('boom'));

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
    );
  });
});

describe('connectRedisClient', () => {
  it('connects once on success', async () => {
    const client = createLifecycleFake();

    await connectRedisClient(client, 'failed');

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting the budget', async () => {
    const client = createLifecycleFake();
    client.connect.mockRejectedValue(new Error('down'));

    await expect(
      connectRedisClient(client, 'failed', {
        attempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
      }),
    ).rejects.toThrow('down');
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
});

describe('quitRedisClient', () => {
  it('quits when the client is open', async () => {
    const client = createLifecycleFake(true);

    await quitRedisClient(client);

    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('skips quit when the client is closed', async () => {
    const client = createLifecycleFake(false);

    await quitRedisClient(client);

    expect(client.quit).not.toHaveBeenCalled();
  });
});
