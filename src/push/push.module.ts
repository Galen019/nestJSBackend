/**
 * Push feature module.
 *
 * - Wires the gRPC fan-out controller to the WS session registry
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WsModule } from '../ws/ws.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/**
 * Feature module exposing the client-streaming `Publish` endpoint.
 *
 * - imports `WsModule` for the shared in-memory `WsService`
 * - provides `PushService` for boundary parsing plus fan-out.
 */
@Module({
  imports: [AuthModule, WsModule],
  controllers: [PushController],
  providers: [PushService],
})
export class PushModule {}
