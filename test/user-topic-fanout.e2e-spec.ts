/**
 * E2E suite for distributed WS fan-out across two replicas sharing a bus.
 *
 * - two WsService + UserTopicService pairs stand in for two app replicas,
 *   sharing one in-memory pub/sub bus behind their publisher/subscriber fakes
 * - each replica wires the real `UserTopicService` through `SESSION_TRACKERS`,
 *   so subscriptions flow through the production path (`handleConnection` →
 *   background fan-out → `handleConnect` → subscribe)
 * - the local-delivery hook mirrors `WsModule`'s constructor wiring, which is
 *   covered in isolation by `ws.module.spec.ts`
 * - broadcast: sendToUser on replica A reaches local sessions on both replicas
 * - isolation: sessions of other users receive nothing
 * - no-echo: the excluded origin client is skipped on every replica.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, it, afterEach, expect, vi } from 'vitest';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { channelFor } from '../src/user-topics/user-topic.message';
import {
  USER_TOPIC_SUBSCRIBER,
  UserTopicService,
} from '../src/user-topics/user-topic.service';
import {
  SESSION_TRACKERS,
  type SessionTracker,
} from '../src/ws/session.interface';
import { WsService } from '../src/ws/ws.service';
import {
  createSocketFake,
  requireClientId,
  requireUserId,
  type SocketFake,
} from './ws-test.helper';
import { createPublisherFake } from './publisher-test.helper';
import {
  connectPublisherToBus,
  connectSubscriberToBus,
  createPubSubBus,
  type PubSubBus,
} from './pubsub-test.helper';
import {
  createSubscriberFake,
  type SubscriberFake,
} from './subscriber-test.helper';

/**
 * One replica: its own registry plus topic service sharing the bus.
 */
interface Replica {
  module: TestingModule;
  ws: WsService;
  subscriber: SubscriberFake;
}

describe('user-topic fan-out (e2e)', () => {
  const modules: TestingModule[] = [];

  /**
   * Builds one replica sharing the bus with the others.
   *
   * @param bus Routing table shared with the other replicas.
   * @return The replica services.
   */
  async function buildReplica(bus: PubSubBus): Promise<Replica> {
    const subscriber = createSubscriberFake();
    connectSubscriberToBus(subscriber, bus);
    const publisher = createPublisherFake();
    connectPublisherToBus(publisher, bus);
    const module = await Test.createTestingModule({
      providers: [
        WsService,
        {
          provide: SESSION_TRACKERS,
          useFactory: (topics: UserTopicService): SessionTracker[] => [topics],
          inject: [UserTopicService],
        },
        { provide: REDIS_CLIENT, useValue: publisher },
        UserTopicService,
        { provide: USER_TOPIC_SUBSCRIBER, useValue: subscriber },
      ],
    }).compile();
    modules.push(module);
    const ws = module.get<WsService>(WsService);
    const topics = module.get<UserTopicService>(UserTopicService);
    topics.setLocalDeliverer((userId, payload, excludeClientId) =>
      ws.sendToLocalUser(userId, payload, excludeClientId),
    );
    return { module, ws, subscriber };
  }

  /**
   * Connects one client through the production fan-out path.
   *
   * - `handleConnection` fans the connect out to the real topic tracker in
   *   the background, so this waits until the subscribe lands before
   *   returning the socket.
   *
   * @param replica Replica to connect to.
   * @param userId Owner of the connection.
   * @param clientId Session key of the connection.
   * @return The fake socket capturing the client's deliveries.
   */
  async function connectClient(
    replica: Replica,
    userId: string,
    clientId: string,
  ): Promise<SocketFake> {
    const fake = createSocketFake();
    replica.ws.handleConnection({
      socket: fake.socket,
      userId: requireUserId(userId),
      clientId: requireClientId(clientId),
    });
    await vi.waitFor(
      () => {
        expect(replica.subscriber.subscribe).toHaveBeenCalledWith(
          channelFor(requireUserId(userId)),
          expect.any(Function),
        );
      },
      { timeout: 3000 },
    );
    return fake;
  }

  afterEach(async () => {
    for (const module of modules.splice(0)) {
      await module.close();
    }
    vi.restoreAllMocks();
  });

  it('delivers a broadcast from replica A to sessions on both replicas', async () => {
    const bus = createPubSubBus();
    const first = await buildReplica(bus);
    const second = await buildReplica(bus);
    const socketA = await connectClient(first, 'user-1', 'client-a');
    const socketB = await connectClient(second, 'user-1', 'client-b');

    await first.ws.sendToUser(requireUserId('user-1'), { type: 'HELLO' });

    expect(socketA.sent).toEqual([JSON.stringify({ type: 'HELLO' })]);
    expect(socketB.sent).toEqual([JSON.stringify({ type: 'HELLO' })]);
  });

  it('delivers nothing to sessions of other users', async () => {
    const bus = createPubSubBus();
    const first = await buildReplica(bus);
    const second = await buildReplica(bus);
    await connectClient(first, 'user-1', 'client-a');
    const peer = await connectClient(second, 'user-2', 'client-b');

    await first.ws.sendToUser(requireUserId('user-1'), { type: 'HELLO' });

    expect(peer.sent).toEqual([]);
  });

  it('skips the excluded origin client on every replica', async () => {
    const bus = createPubSubBus();
    const first = await buildReplica(bus);
    const second = await buildReplica(bus);
    const origin = await connectClient(first, 'user-1', 'client-a');
    const peer = await connectClient(second, 'user-1', 'client-b');

    await first.ws.sendToUser(
      requireUserId('user-1'),
      { type: 'HELLO' },
      requireClientId('client-a'),
    );

    expect(origin.sent).toEqual([]);
    expect(peer.sent).toEqual([JSON.stringify({ type: 'HELLO' })]);
  });
});
