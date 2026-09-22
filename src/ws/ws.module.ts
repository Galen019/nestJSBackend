/**
 * WebSocket feature module.
 *
 * - Registers the `/ws` gateway and its session registry service
 */

import { Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Feature module wiring the WebSocket gateway to its registry.
 *
 * - Provides `WsGateway` for the `/ws` endpoint lifecycle
 * - Provides and exports `WsService` for session lookup and sends.
 */
@Module({
  providers: [WsGateway, WsService],
  exports: [WsService],
})
export class WsModule {}
