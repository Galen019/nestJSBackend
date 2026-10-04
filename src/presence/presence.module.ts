/**
 * Presence feature module.
 *
 * - Imports `DynamoModule` for the shared DynamoDB client wrapper
 * - Provides and exports `PresenceService` for WS session tracking.
 */
import { Module } from '@nestjs/common';
import { DynamoModule } from '../dynamo/dynamo.module';
import { PresenceService } from './presence.service';

/**
 * Feature module wiring the presence writer to DynamoDB.
 *
 * - Imported by `WsModule` so `WsService` can track connects/disconnects.
 */
@Module({
  imports: [DynamoModule],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
