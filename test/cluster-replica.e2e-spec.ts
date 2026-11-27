/**
 * E2E suite for replica-safe WebSocket claims and fan-out.
 *
 * - two service pairs stand in for two app replicas sharing one claim store
 *   and one in-memory pub/sub bus through the test fakes
 * - claims: a client ID held by one replica cannot be claimed by the other,
 *   and a stale close cannot release a later owner's claim
 * - renewal: the owning replica extends its claim without losing ownership
 * - fan-out: user broadcasts still reach local sessions on both replicas
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_REDIS_CLIENT } from '../src/cluster/cluster.constants';
import { ClusterService } from '../src/cluster/cluster.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import {
  USER_TOPIC_SUBSCRIBER,
  UserTopicService,
} from '../src/user-topics/user-topic.service';
import {
  SESSION_TRACKERS,
  type SessionTracker,
} from '../src/ws/session.interface';
import { WsService } from '../src/ws/ws.service';
import { createClusterFake } from './cluster-test.helper';
import {
  createPublisherFake,
  type PublisherFake,
} from './publisher-test.helper';
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
import {
  createSocketFake,
  fireClose,
  futureExpiryMs,
  requireClientId,
  requireUserId,
  type SocketFake,
} from './ws-test.helper';

/**
 * One in-process replica with its own registry and Redis fakes.
 */
interface Replica {
  /** Testing module owning the replica's providers. */
  module: TestingModule;
  /** Session registry. */
  ws: WsService;
  /** Cluster coordinator. */
  cluster: ClusterService;
  /** User-topic subscriber fake. */
  topics: SubscriberFake;
}

/**
 * Connected socket plus its cluster claim token.
 */
interface ConnectedClient {
  /** Fake socket capturing deliveries. */
  fake: SocketFake;
  /** Token returned by the winning claim. */
  claimToken: string;
}

describe('cluster replica claims (e2e)', () => {
  const modules: TestingModule[] = [];

  /**
   * Builds one replica sharing the bus and claim store with its peers.
   *
   * @param bus Shared pub/sub routing table.
   * @param store Shared client claim store.
   * @return The replica services and subscriber fake.
   */
  async function buildReplica(
    bus: PubSubBus,
    store: Map<string, string>,
  ): Promise<Replica> {
    const clusterFake = createClusterFake(store);
    const topics = createSubscriberFake();
    connectSubscriberToBus(topics, bus);
    const publisher: PublisherFake = createPublisherFake();
    connectPublisherToBus(publisher, bus);
    const module = await Test.createTestingModule({
      providers: [
        WsService,
        ClusterService,
        UserTopicService,
        {
          provide: SESSION_TRACKERS,
          useFactory: (topicService: UserTopicService): SessionTracker[] => [
            topicService,
          ],
          inject: [UserTopicService],
        },
        { provide: REDIS_CLIENT, useValue: publisher },
        { provide: CLUSTER_REDIS_CLIENT, useValue: clusterFake.client },
        { provide: USER_TOPIC_SUBSCRIBER, useValue: topics },
      ],
    }).compile();
    modules.push(module);
    const ws = module.get<WsService>(WsService);
    const cluster = module.get<ClusterService>(ClusterService);
    const topicService = module.get<UserTopicService>(UserTopicService);
    topicService.setLocalDeliverer((userId, payload, excludeClientId) =>
      ws.sendToLocalUser(userId, payload, excludeClientId),
    );
    await cluster.onModuleInit();
    return { module, ws, cluster, topics };
  }

  /**
   * Claims a client and registers it through the production fan-out path.
   *
   * @param replica Owning replica.
   * @param userId Owning user.
   * @param clientId Session key to register.
   * @return The fake socket and its claim token.
   */
  async function connect(
    replica: Replica,
    userId: string,
    clientId: string,
  ): Promise<ConnectedClient> {
    const id = requireClientId(clientId);
    const claimToken = await replica.cluster.claimClient(id);
    if (claimToken === undefined) {
      throw new Error(`Expected to claim ${clientId}`);
    }
    const fake = createSocketFake();
    const result = replica.ws.handleConnection({
      socket: fake.socket,
      userId: requireUserId(userId),
      clientId: id,
      expiresAt: futureExpiryMs(),
      claimToken,
    });
    if (result.kind !== 'registered') {
      throw new Error(`Expected ${clientId} to register`);
    }
    await result.pending;
    return { fake, claimToken };
  }

  afterEach(async () => {
    for (const module of modules.splice(0)) {
      await module.close();
    }
    vi.restoreAllMocks();
  });

  it('rejects a client ID already claimed by another replica', async () => {
    const bus = createPubSubBus();
    const store = new Map<string, string>();
    const first = await buildReplica(bus, store);
    const second = await buildReplica(bus, store);
    const connected = await connect(first, 'user-1', 'client-a');

    await expect(
      second.cluster.claimClient(requireClientId('client-a')),
    ).resolves.toBeUndefined();
    expect(second.ws.getSessionCount()).toBe(0);

    fireClose(connected.fake);
    await vi.waitFor(() => {
      expect(store.size).toBe(0);
    });
    await expect(
      second.cluster.claimClient(requireClientId('client-a')),
    ).resolves.toEqual(expect.any(String));
  });

  it('does not let a stale close release a reconnected owner', async () => {
    const bus = createPubSubBus();
    const store = new Map<string, string>();
    const first = await buildReplica(bus, store);
    const second = await buildReplica(bus, store);
    const connected = await connect(first, 'user-1', 'client-a');
    const clientId = requireClientId('client-a');

    fireClose(connected.fake);
    await vi.waitFor(() => {
      expect(store.size).toBe(0);
    });
    const nextClaim = await second.cluster.claimClient(clientId);
    expect(nextClaim).toEqual(expect.any(String));

    await first.cluster.releaseClient(clientId, connected.claimToken);

    expect(store.size).toBe(1);
    await expect(first.cluster.claimClient(clientId)).resolves.toBeUndefined();
  });

  it('renews the claim held by the owning replica', async () => {
    const bus = createPubSubBus();
    const store = new Map<string, string>();
    const first = await buildReplica(bus, store);
    const second = await buildReplica(bus, store);
    const connected = await connect(first, 'user-1', 'client-a');
    const clientId = requireClientId('client-a');

    await expect(
      first.cluster.renewClient(clientId, connected.claimToken),
    ).resolves.toBe(true);
    expect(store.get('ws:claim:client-a')).toBe(connected.claimToken);
    await expect(second.cluster.claimClient(clientId)).resolves.toBeUndefined();
  });

  it('keeps user broadcasts working alongside claims', async () => {
    const bus = createPubSubBus();
    const store = new Map<string, string>();
    const first = await buildReplica(bus, store);
    const second = await buildReplica(bus, store);
    const firstClient = await connect(first, 'user-1', 'client-a');
    const secondClient = await connect(second, 'user-1', 'client-b');

    await second.ws.sendToUser(
      requireUserId('user-1'),
      { type: 'PING' },
      requireClientId('client-b'),
    );

    expect(firstClient.fake.sent).toEqual([JSON.stringify({ type: 'PING' })]);
    expect(secondClient.fake.sent).toEqual([]);
    expect(first.topics.subscribe).toHaveBeenCalledWith(
      'user:user-1',
      expect.any(Function),
    );
  });
});
