/**
 * Metrics DI module.
 *
 * - Provides the shared MetricsService registry for middleware and scraping
 * - Applies MetricsMiddleware to every route; probes are excluded here via
 *   the framework so the middleware never sees them.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { METRICS_PATH } from './metrics.constants';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';

@Module({
  providers: [MetricsService, MetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  /**
   * Registers the metrics middleware on all routes except probes.
   *
   * @param consumer Nest middleware consumer for route binding.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(MetricsMiddleware)
      .exclude('/health', '/health/', METRICS_PATH, `${METRICS_PATH}/`)
      .forRoutes('*');
  }
}
