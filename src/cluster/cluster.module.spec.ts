/** Unit suite for ClusterModule provider wiring. */
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, it, expect, afterEach } from 'vitest';
import { CLUSTER_REDIS_CLIENT } from './cluster.constants';
import { ClusterService, type ClusterCommandClient } from './cluster.service';
import { ClusterModule } from './cluster.module';

describe('ClusterModule', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('provides ClusterService with its command client', async () => {
    const command = {
      isOpen: false,
      connect: async (): Promise<void> => undefined,
      quit: async (): Promise<string> => 'OK',
      on: (): void => undefined,
      set: async (): Promise<string | null> => 'OK',
      eval: async (): Promise<number> => 0,
    } satisfies ClusterCommandClient;
    module = await Test.createTestingModule({ imports: [ClusterModule] })
      .overrideProvider(CLUSTER_REDIS_CLIENT)
      .useValue(command)
      .compile();

    expect(module.get<ClusterService>(ClusterService)).toBeInstanceOf(
      ClusterService,
    );
  });
});
