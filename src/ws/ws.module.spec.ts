/**
 * Unit suite for WsModule delivery wiring.
 *
 * - boots the module's providers through Nest DI so its constructor runs
 * - proves an inbound topic message reaches a local session with no manual
 *   `setLocalDeliverer` call anywhere: the constructor registration is the
 *   only wiring, so delivery working means the wiring ran.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { buildUserTopicEnvelope } from '../user-topics/user-topic.message';
import {
  USER_TOPIC_SUBSCRIBER,
  UserTopicService,
} from '../user-topics/user-topic.service';
import { createPublisherFake } from '../../test/publisher-test.helper';
import {
  createSubscriberFake,
  type SubscriberFake,
} from '../../test/subscriber-test.helper';
import {
  createSocketFake,
  requireClientId,
  requireUserId,
} from '../../test/ws-test.helper';
import { SESSION_TRACKERS, type SessionTracker } from './session.interface';
import { WsModule } from './ws.module';
import { WsService } from './ws.service';

describe('WsModule', () => {
  let module: TestingModule | undefined;
  let ws: WsService;
  let subscriber: SubscriberFake;

  beforeEach(async () => {
    subscriber = createSubscriberFake();
    module = await Test.createTestingModule({
      providers: [
        WsService,
        {
          provide: SESSION_TRACKERS,
          useFactory: (topics: UserTopicService): SessionTracker[] => [topics],
          inject: [UserTopicService],
        },
        { provide: REDIS_CLIENT, useValue: createPublisherFake() },
        UserTopicService,
        { provide: USER_TOPIC_SUBSCRIBER, useValue: subscriber },
        WsModule,
      ],
    }).compile();
    ws = module.get<WsService>(WsService);
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('delivers inbound topic messages to local sessions via constructor wiring', async () => {
    const fake = createSocketFake();
    ws.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-1'),
      clientId: requireClientId('client-a'),
    });
    await vi.waitFor(
      () => {
        expect(subscriber.subscribe).toHaveBeenCalledWith(
          'user:user-1',
          expect.any(Function),
        );
      },
      { timeout: 3000 },
    );
    const listener = subscriber.subscribe.mock.calls[0]?.[1];
    if (typeof listener !== 'function') {
      throw new Error('Expected a subscribe listener');
    }

    listener(buildUserTopicEnvelope({ type: 'PING' }), 'user:user-1');

    expect(fake.sent).toEqual([JSON.stringify({ type: 'PING' })]);
  });
});
