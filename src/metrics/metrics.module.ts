/**
 * Metrics DI module.
 *
 * - Provides the shared MetricsService registry for middleware and scraping
 * - Applies MetricsMiddleware to every route; the scrape path is excluded
 *   here while health probes skip recording inside the middleware.
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
   * Registers the metrics middleware on all routes except the scrape path.
   *
   * @param consumer Nest middleware consumer for route binding.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(MetricsMiddleware)
      .exclude(METRICS_PATH, `${METRICS_PATH}/`)
      .forRoutes('*');
  }
}
