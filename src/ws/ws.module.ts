/**
 * WebSocket feature module.
 *
 * - Registers the `/ws` gateway plus its session registry
 * - Fans registry lifecycle out to presence and per-user topics via trackers
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { PresenceService } from '../presence/presence.service';
import { UserTopicsModule } from '../user-topics/user-topics.module';
import { UserTopicService } from '../user-topics/user-topic.service';
import { SESSION_TRACKERS, type SessionTracker } from './session.interface';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Feature module wiring the WebSocket gateway to its registry.
 *
 * - Provides `WsGateway` for the `/ws` endpoint lifecycle
 * - Provides and exports `WsService` for session lookup and sends
 * - Provides the ordered `SESSION_TRACKERS` fan-out list; tracker N+1 is a
 *   new entry here, with no edits to `WsService`.
 */
@Module({
  imports: [AuthModule, PresenceModule, UserTopicsModule],
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
export class WsModule {}
