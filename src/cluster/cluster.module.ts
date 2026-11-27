/**
 * Registers the cluster coordination client and service.
 *
 * - command client owns short-lived client claims
 */

import { Module } from '@nestjs/common';
import {
  CLUSTER_REDIS_CLIENT,
  createClusterRedisClient,
} from './cluster.constants';
import { ClusterService, type ClusterCommandClient } from './cluster.service';

/**
 * Provides `ClusterService` for WebSocket client claims.
 */
@Module({
  providers: [
    {
      provide: CLUSTER_REDIS_CLIENT,
      useFactory: (): ClusterCommandClient => createClusterRedisClient(),
    },
    ClusterService,
  ],
  exports: [ClusterService],
})
export class ClusterModule {}
