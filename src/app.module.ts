import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { RedisModule } from './redis/redis.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [RedisModule, WsModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
