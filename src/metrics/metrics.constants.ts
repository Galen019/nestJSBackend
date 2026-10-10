/**
 * Metric identity for per-route HTTP observability.
 *
 * - single owner of meter name, instrument names, units, and buckets
 * - consumed by MetricsService and MetricsModule, never by middleware.
 */

/** Meter name used for all per-route instruments. */
export const METRICS_METER_NAME = 'production-backend';

/** DI token for the shared OTel Meter. */
export const METRICS_METER_TOKEN = 'METRICS_METER';

/** Counter of completed HTTP requests, grouped by route labels. */
export const HTTP_REQUEST_TOTAL = 'http.request.total';

/** Histogram of HTTP handler duration in seconds. */
export const HTTP_REQUEST_DURATION = 'http.request.duration';

/** Unit for the duration histogram. */
export const DURATION_UNIT_SECONDS = 's';

/** Histogram bucket boundaries in seconds. */
export const DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
