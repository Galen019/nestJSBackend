/**
 * Registers the WebSocket gateway and session registry.
 *
 * - Connects lifecycle trackers and distributed broadcasts to local delivery
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { PresenceService } from '../presence/presence.service';
import { RedisModule } from '../redis/redis.module';
import { UserTopicsModule } from '../user-topics/user-topics.module';
import { UserTopicService } from '../user-topics/user-topic.service';
import { SESSION_TRACKERS, type SessionTracker } from './session.interface';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Wires the WebSocket gateway, registry, and session trackers.
 *
 * - Exports `WsService` for session lookup and sends
 * - Uses `RedisModule` for broadcasts and registers session trackers
 */
@Module({
  imports: [AuthModule, PresenceModule, RedisModule, UserTopicsModule],
  providers: [
    {
      provide: SESSION_TRACKERS,
      useFactory: (
        presence: PresenceService,
        topics: UserTopicService,
      ): SessionTracker[] => [presence, topics],
      inject: [PresenceService, UserTopicService],
    },
    WsGateway,
    WsService,
  ],
  exports: [WsService],
})
export class WsModule {
  /**
   * Registers local topic delivery before connections or subscriptions start.
   *
   * @param wsService Registry owning the local-delivery loop.
   * @param topics Topic service receiving the delivery hook.
   */
  constructor(
    private readonly wsService: WsService,
    private readonly topics: UserTopicService,
  ) {
    this.topics.setLocalDeliverer((userId, payload, excludeClientId) =>
      this.wsService.sendToLocalUser(userId, payload, excludeClientId),
    );
  }
}
