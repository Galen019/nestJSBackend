/**
 * Unit suite for UserTopicService with a mocked subscriber connection.
 *
 * - lifecycle: onModuleInit connects, onModuleDestroy quits only when open
 * - connect: first connect claims and subscribes, later connects no-op
 * - disconnect: last disconnect unsubscribes, earlier ones keep it
 * - safety: unclaimed channels never unsubscribe, errors never reach callers
 * - retry: subscribe/unsubscribe retry within budget, failures heal on next connect
 * - delivery: valid envelopes reach the registered deliverer with channel
 *   authority, malformed envelopes and foreign channels drop with a warn,
 *   and an unregistered deliverer throws loudly instead of dropping silently.
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
import { buildUserTopicEnvelope } from './user-topic.message';
import {
  USER_TOPIC_SUBSCRIBER,
  UserTopicService,
  type LocalUserDeliverer,
} from './user-topic.service';

/**
 * Builds a lifecycle event for one user with a fixed token.
 *
 * - connects and disconnects share the shape; only `userSessionCount`
 *   differs (total after the event for connects, remainder for disconnects).
 *
 * @param userId Owner of the connection.
 * @param clientId Session key of the connection.
 * @param userSessionCount Local sessions for the user after the event.
 * @return The lifecycle event to fan out.
 */
function sessionEvent(
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

  /**
   * Captures the topic listener registered for one user's channel.
   *
   * - subscribes the user, then returns the listener the service handed to
   *   the subscriber fake.
   *
   * @param userId Owner whose channel to subscribe.
   * @return The captured topic listener.
   */
  async function captureListener(
    userId: string,
  ): Promise<(message: string, channel: string) => unknown> {
    await service.handleConnect(sessionEvent(userId, 'client-1', 1));
    const listener = subscriber.subscribe.mock.calls[0]?.[1];
    if (typeof listener !== 'function') {
      throw new Error('Expected a subscribe listener');
    }
    return listener;
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

  it('subscribes once on the first connect for a user', async () => {
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    await service.handleConnect(sessionEvent('user-123', 'client-2', 2));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'user:user-123',
      expect.any(Function),
    );
  });

  it('subscribes independently per user', async () => {
    await service.handleConnect(sessionEvent('user-1', 'client-1', 1));
    await service.handleConnect(sessionEvent('user-2', 'client-2', 1));

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
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    await service.handleConnect(sessionEvent('user-123', 'client-2', 2));

    await service.handleDisconnect(sessionEvent('user-123', 'client-1', 1));

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes on the last disconnect', async () => {
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));

    await service.handleDisconnect(sessionEvent('user-123', 'client-1', 0));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('user:user-123');
  });

  it('only unsubscribes the disconnected user when others stay connected', async () => {
    await service.handleConnect(sessionEvent('user-1', 'client-1', 1));
    await service.handleConnect(sessionEvent('user-2', 'client-2', 1));

    await service.handleDisconnect(sessionEvent('user-1', 'client-1', 0));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('user:user-1');
  });

  it('ignores a disconnect for an unclaimed channel', async () => {
    await service.handleDisconnect(sessionEvent('ghost', 'client-9', 0));

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });

  it('ignores a duplicated disconnect without a second unsubscribe', async () => {
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    await service.handleDisconnect(sessionEvent('user-123', 'client-1', 0));

    await service.handleDisconnect(sessionEvent('user-123', 'client-1', 0));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('retries subscribe within budget and stays claimed after recovery', async () => {
    subscriber.subscribe.mockRejectedValueOnce(new Error('READONLY'));

    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    await service.handleConnect(sessionEvent('user-123', 'client-2', 2));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when subscribe keeps failing so the next connect retries', async () => {
    subscriber.subscribe.mockRejectedValue(new Error('READONLY'));

    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    expect(subscriber.subscribe).toHaveBeenCalledTimes(5);

    subscriber.subscribe.mockResolvedValue(undefined);
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(6);
  });

  it('retries unsubscribe within budget on failure', async () => {
    await service.handleConnect(sessionEvent('user-123', 'client-1', 1));
    subscriber.unsubscribe.mockRejectedValueOnce(new Error('READONLY'));

    await service.handleDisconnect(sessionEvent('user-123', 'client-1', 0));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('never throws to the caller when subscribe keeps failing', async () => {
    subscriber.subscribe.mockRejectedValue(new Error('READONLY'));

    await expect(
      service.handleConnect(sessionEvent('user-123', 'client-1', 1)),
    ).resolves.toBeUndefined();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(5);
  });

  it('delivers a valid envelope to the registered deliverer', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(2);
    service.setLocalDeliverer(deliverer);
    const listener = await captureListener('user-123');

    listener(buildUserTopicEnvelope({ type: 'PING' }), 'user:user-123');

    expect(deliverer).toHaveBeenCalledTimes(1);
    expect(deliverer).toHaveBeenCalledWith(
      requireUserId('user-123'),
      { type: 'PING' },
      undefined,
    );
  });

  it('passes the excluded origin client through to the deliverer', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(1);
    service.setLocalDeliverer(deliverer);
    const listener = await captureListener('user-123');

    listener(
      buildUserTopicEnvelope({ type: 'PING' }, requireClientId('client-9')),
      'user:user-123',
    );

    expect(deliverer).toHaveBeenCalledWith(
      requireUserId('user-123'),
      { type: 'PING' },
      requireClientId('client-9'),
    );
  });

  it('drops malformed envelopes with a warn and no delivery', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(1);
    service.setLocalDeliverer(deliverer);
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const listener = await captureListener('user-123');

    listener('not-json{', 'user:user-123');

    expect(deliverer).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropping topic message on user:user-123'),
    );
  });

  it('drops envelopes without a payload with a warn and no delivery', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(1);
    service.setLocalDeliverer(deliverer);
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const listener = await captureListener('user-123');

    listener(JSON.stringify({ excludeClientId: 'client-1' }), 'user:user-123');

    expect(deliverer).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing payload'),
    );
  });

  it('drops foreign channels with a warn and no delivery', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(1);
    service.setLocalDeliverer(deliverer);
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const listener = await captureListener('user-123');

    listener(buildUserTopicEnvelope({ type: 'PING' }), 'other:user-123');

    expect(deliverer).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('foreign channel'),
    );
  });

  it('throws loudly without a registered deliverer instead of dropping', async () => {
    const listener = await captureListener('user-123');

    expect(() =>
      listener(buildUserTopicEnvelope({ type: 'PING' }), 'user:user-123'),
    ).toThrow(/local deliverer not registered/);
  });

  it('debug-logs channel, bytes, and delivered count on delivery', async () => {
    const deliverer = vi.fn<LocalUserDeliverer>().mockReturnValue(1);
    service.setLocalDeliverer(deliverer);
    const debugSpy = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const listener = await captureListener('user-123');

    listener(buildUserTopicEnvelope({ type: 'PING' }), 'user:user-123');

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('user:user-123'),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 local sessions'),
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
