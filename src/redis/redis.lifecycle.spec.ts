/**
 * Unit suite for the shared Redis quit helper.
 *
 * - quits when open, skips when closed.
 */
import { describe, it, expect, vi } from 'vitest';
import { quitRedisClient } from './redis.lifecycle';

/**
 * Creates a fake lifecycle client with a mocked quit.
 *
 * @param isOpen Whether the fake reports an open connection.
 * @return Fake client plus its quit mock.
 */
function createLifecycleFake(isOpen = false) {
  return {
    isOpen,
    quit: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
}

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
