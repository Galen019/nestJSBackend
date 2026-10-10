/**
 * Metrics feature module.
 *
 * - provides the shared OTel Meter from the global provider
 * - registers MetricsService and the global per-route middleware
 * - imported once by AppModule, no per-controller wiring needed.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { METRICS_METER_NAME, METRICS_METER_TOKEN } from './metrics.constants';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';

/**
 * Feature module wiring per-route HTTP metrics.
 */
@Module({
  providers: [
    {
      provide: METRICS_METER_TOKEN,
      useFactory: (): Meter => metrics.getMeter(METRICS_METER_NAME),
    },
    MetricsService,
    MetricsMiddleware,
  ],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  /**
   * Applies the metrics middleware to every route.
   *
   * - middleware runs before guards, so 401s are recorded
   * - the recorder itself skips health probes.
   *
   * @param consumer Nest middleware consumer for route registration.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
