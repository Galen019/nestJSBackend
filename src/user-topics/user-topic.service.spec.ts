/**
 * Unit suite for UserTopicService with a mocked subscriber connection.
 *
 * - channels: channelFor builds `user:{userId}`
 * - lifecycle: onModuleInit connects, onModuleDestroy quits only when open
 * - connect: first connect claims and subscribes, later connects no-op
 * - disconnect: last disconnect unsubscribes, earlier ones keep it
 * - safety: unclaimed channels never unsubscribe, errors never reach callers
 * - retry: subscribe/unsubscribe retry within budget, failures heal on next connect
 * - listener: the subscribe listener debug-logs channel plus byte length only.
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSubscriberFake,
  type SubscriberFake,
} from '../../test/subscriber-test.helper';
import { requireClientId, requireUserId } from '../../test/ws-test.helper';
import type { SessionLifecycleEvent } from '../ws/session.interface';
import {
  channelFor,
  USER_TOPIC_SUBSCRIBER,
  UserTopicService,
} from './user-topic.service';

/**
 * Builds a connect event for one user with a fixed token.
 *
 * @param userId Owner of the connection.
 * @param clientId Session key of the connection.
 * @param userSessionCount Local sessions for the user after the event.
 * @return The lifecycle event to fan out.
 */
function connectEvent(
  userId: string,
  clientId: string,
  userSessionCount: number,
): SessionLifecycleEvent {
  return {
    userId: requireUserId(userId),
    clientId: requireClientId(clientId),
    token: 'token-1',
    userSessionCount,
  };
}

/**
 * Builds a disconnect event for one user with a fixed token.
 *
 * @param userId Owner of the closed connection.
 * @param clientId Session key of the closed connection.
 * @param userSessionCount Local sessions remaining for the user.
 * @return The lifecycle event to fan out.
 */
function disconnectEvent(
  userId: string,
  clientId: string,
  userSessionCount: number,
): SessionLifecycleEvent {
  return {
    userId: requireUserId(userId),
    clientId: requireClientId(clientId),
    token: 'token-1',
    userSessionCount,
  };
}

/**
 * Flushes the fire-and-forget subscribe/unsubscribe background tasks.
 *
 * - the service never exposes those promises, so tests yield macrotasks
 * - resolves after pending promise continuations have run.
 *
 * @return Resolves on the next macrotask.
 */
function flushBackground(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('UserTopicService', () => {
  let service: UserTopicService;
  let module: TestingModule | undefined;
  let subscriber: SubscriberFake;

  /**
   * Builds a testing module with a fresh UserTopicService.
   *
   * - provides the mocked subscriber so no Redis connection happens
   * - tracks the module so it can be closed after each test.
   */
  async function compile(): Promise<UserTopicService> {
    module = await Test.createTestingModule({
      providers: [
        UserTopicService,
        {
          provide: USER_TOPIC_SUBSCRIBER,
          useValue: subscriber,
        },
      ],
    }).compile();
    return module.get<UserTopicService>(UserTopicService);
  }

  beforeEach(async () => {
    subscriber = createSubscriberFake();
    service = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('builds the channel as user:{userId}', () => {
    expect(channelFor(requireUserId('user-123'))).toBe('user:user-123');
  });

  it('subscribes once on the first connect for a user', async () => {
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    await flushBackground();
    service.handleConnect(connectEvent('user-123', 'client-2', 2));
    await flushBackground();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'user:user-123',
      expect.any(Function),
    );
  });

  it('subscribes independently per user', async () => {
    service.handleConnect(connectEvent('user-1', 'client-1', 1));
    service.handleConnect(connectEvent('user-2', 'client-2', 1));
    await flushBackground();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'user:user-1',
      expect.any(Function),
    );
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'user:user-2',
      expect.any(Function),
    );
  });

  it('does not unsubscribe until the last disconnect', async () => {
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    service.handleConnect(connectEvent('user-123', 'client-2', 2));
    await flushBackground();

    service.handleDisconnect(disconnectEvent('user-123', 'client-1', 1));
    await flushBackground();

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes on the last disconnect', async () => {
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    await flushBackground();

    service.handleDisconnect(disconnectEvent('user-123', 'client-1', 0));
    await flushBackground();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('user:user-123');
  });

  it('only unsubscribes the disconnected user when others stay connected', async () => {
    service.handleConnect(connectEvent('user-1', 'client-1', 1));
    service.handleConnect(connectEvent('user-2', 'client-2', 1));
    await flushBackground();

    service.handleDisconnect(disconnectEvent('user-1', 'client-1', 0));
    await flushBackground();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('user:user-1');
  });

  it('ignores a disconnect for an unclaimed channel', async () => {
    service.handleDisconnect(disconnectEvent('ghost', 'client-9', 0));
    await flushBackground();

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });

  it('ignores a duplicated disconnect without a second unsubscribe', async () => {
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    await flushBackground();
    service.handleDisconnect(disconnectEvent('user-123', 'client-1', 0));
    await flushBackground();

    service.handleDisconnect(disconnectEvent('user-123', 'client-1', 0));
    await flushBackground();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('retries subscribe within budget and stays claimed after recovery', async () => {
    subscriber.subscribe.mockRejectedValueOnce(new Error('READONLY'));

    service.handleConnect(connectEvent('user-123', 'client-1', 1));

    await vi.waitFor(
      () => {
        expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    service.handleConnect(connectEvent('user-123', 'client-2', 2));
    await flushBackground();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when subscribe keeps failing so the next connect retries', async () => {
    subscriber.subscribe.mockRejectedValue(new Error('READONLY'));

    service.handleConnect(connectEvent('user-123', 'client-1', 1));

    await vi.waitFor(
      () => {
        expect(subscriber.subscribe).toHaveBeenCalledTimes(5);
      },
      { timeout: 3000 },
    );
    await flushBackground();
    subscriber.subscribe.mockResolvedValue(undefined);
    service.handleConnect(connectEvent('user-123', 'client-1', 1));

    await vi.waitFor(
      () => {
        expect(subscriber.subscribe).toHaveBeenCalledTimes(6);
      },
      { timeout: 3000 },
    );
  });

  it('retries unsubscribe within budget on failure', async () => {
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    await flushBackground();
    subscriber.unsubscribe.mockRejectedValueOnce(new Error('READONLY'));

    service.handleDisconnect(disconnectEvent('user-123', 'client-1', 0));

    await vi.waitFor(
      () => {
        expect(subscriber.unsubscribe).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
  });

  it('never throws to the caller when subscribe keeps failing', async () => {
    subscriber.subscribe.mockRejectedValue(new Error('READONLY'));

    expect(() =>
      service.handleConnect(connectEvent('user-123', 'client-1', 1)),
    ).not.toThrow();

    await vi.waitFor(
      () => {
        expect(subscriber.subscribe).toHaveBeenCalledTimes(5);
      },
      { timeout: 3000 },
    );
  });

  it('debug-logs channel and bytes when a topic message arrives', async () => {
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    service.handleConnect(connectEvent('user-123', 'client-1', 1));
    await flushBackground();
    const listener = subscriber.subscribe.mock.calls[0]?.[1];
    if (typeof listener !== 'function') {
      throw new Error('Expected a subscribe listener');
    }

    listener('hello', 'user:user-123');

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('user:user-123'),
    );
  });

  it('forwards subscriber errors to the logger', () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const listener = subscriber.on.mock.calls[0]?.[1];
    if (typeof listener !== 'function') {
      throw new Error('Expected an error listener');
    }

    listener(new Error('boom'));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('connects the subscriber on module init', async () => {
    await service.onModuleInit();

    expect(subscriber.connect).toHaveBeenCalledTimes(1);
  });

  it('quits the subscriber on destroy when open', async () => {
    subscriber.isOpen = true;

    await service.onModuleDestroy();

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
  });

  it('skips quit on destroy when closed', async () => {
    await service.onModuleDestroy();

    expect(subscriber.quit).not.toHaveBeenCalled();
  });
});
