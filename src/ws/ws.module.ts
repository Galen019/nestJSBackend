/**
 * WebSocket feature module.
 *
 * - Registers the `/ws` gateway and its session registry service
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Feature module wiring the WebSocket gateway to its registry.
 *
 * - Provides `WsGateway` for the `/ws` endpoint lifecycle
 * - Provides and exports `WsService` for session lookup and sends.
 */
@Module({
  imports: [AuthModule],
  providers: [WsGateway, WsService],
  exports: [WsService],
})
export class WsModule {}
