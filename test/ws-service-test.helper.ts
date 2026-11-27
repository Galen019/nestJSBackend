/**
 * Test-only WsService module with fake cluster, publisher, and trackers.
 *
 * - single owner of the standard registry harness used by focused specs
 * - exposes the fakes so suites can drive claims, trackers, and broadcasts
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { vi } from 'vitest';
import { ClusterService } from '../src/cluster/cluster.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import {
  SESSION_TRACKERS,
  type SessionLifecycleEvent,
} from '../src/ws/session.interface';
import { WsService } from '../src/ws/ws.service';
import {
  createPublisherFake,
  type PublisherFake,
} from './publisher-test.helper';

/** Tracker mock shared by the focused WsService specs. */
export interface TrackerFake {
  /** Resolves on connect. */
  handleConnect: ReturnType<
    typeof vi.fn<(event: SessionLifecycleEvent) => Promise<void>>
  >;
  /** Resolves on disconnect. */
  handleDisconnect: ReturnType<
    typeof vi.fn<(event: SessionLifecycleEvent) => Promise<void>>
  >;
}

/** A compiled WsService module and the fakes backing it. */
export interface WsServiceHarness {
  /** Service under test. */
  service: WsService;
  /** Compiled module, closed by the suite after each test. */
  module: TestingModule;
  /** Publisher fake. */
  publisher: PublisherFake;
  /** Cluster fake with claim release and renewal mocks. */
  cluster: {
    releaseClient: ReturnType<typeof vi.fn>;
    renewClient: ReturnType<typeof vi.fn>;
  };
  /** Tracker fake. */
  tracker: TrackerFake;
}

/**
 * Compiles an isolated WsService with all side effects faked.
 *
 * @return The service, its module, and the injected fakes.
 */
export async function createWsServiceHarness(): Promise<WsServiceHarness> {
  const publisher = createPublisherFake();
  const cluster = {
    releaseClient: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    renewClient: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const tracker: TrackerFake = {
    handleConnect: vi
      .fn<(event: SessionLifecycleEvent) => Promise<void>>()
      .mockResolvedValue(undefined),
    handleDisconnect: vi
      .fn<(event: SessionLifecycleEvent) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({
    providers: [
      WsService,
      { provide: SESSION_TRACKERS, useValue: [tracker] },
      { provide: REDIS_CLIENT, useValue: publisher },
      { provide: ClusterService, useValue: cluster },
    ],
  }).compile();
  return {
    service: module.get<WsService>(WsService),
    module,
    publisher,
    cluster,
    tracker,
  };
}
