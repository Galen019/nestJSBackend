/**
 * Shared Prometheus metadata and metrics env config.
 *
 * - Single owner of the scrape port, scrape path, metric names, and buckets
 * - METRICS_ENABLED gates the scrape server only; the in-process registry
 *   always records so tests can assert without binding a port.
 */
import { parseEnvFlag } from '../common/env';

/** Fixed port for the standalone Prometheus scrape server. */
export const METRICS_PORT = 9464;

/** Scrape path served by the standalone metrics server. */
export const METRICS_PATH = '/metrics';

/** Counter for total HTTP requests by method, route template, and status. */
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';

/** Histogram for HTTP request durations by method, route, and status. */
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';

/** Route label for requests that matched no Express route (e.g. 404s). */
export const UNKNOWN_ROUTE = 'unknown';

/** Latency buckets in seconds for the duration histogram. */
export const HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];

/** Validated metrics runtime config. */
export interface MetricsConfig {
  enabled: boolean;
}

/**
 * Reads the metrics runtime config from the environment.
 *
 * @return The validated enabled flag.
 */
export function getMetricsConfig(): MetricsConfig {
  return {
    enabled: parseEnvFlag(process.env.METRICS_ENABLED, {
      defaultValue: true,
      warnOnUnknown: true,
      label: 'METRICS_ENABLED',
    }),
  };
}
