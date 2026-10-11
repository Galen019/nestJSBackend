import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DynamoModule } from './dynamo/dynamo.module';
import { LiveController, ReadyController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [AuthModule, RedisModule, DynamoModule, WsModule, MetricsModule],
  controllers: [AppController, LiveController, ReadyController],
  providers: [AppService],
})
export class AppModule {}
