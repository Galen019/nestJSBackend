import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PushModule } from './push/push.module';
import { RedisModule } from './redis/redis.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [AuthModule, RedisModule, WsModule, PushModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
