/**
 * OTel-backed recorder for per-route HTTP counts and durations.
 *
 * - owns Counter and Histogram creation from the injected Meter
 * - exposes a single `recordRequest` entry point for the middleware
 * - sole owner of the health skip, so scrape traffic never pollutes metrics.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Attributes, Counter, Histogram, Meter } from '@opentelemetry/api';
import { isHealthRequest } from '../tracing';
import {
  DURATION_BUCKETS_SECONDS,
  DURATION_UNIT_SECONDS,
  HTTP_REQUEST_DURATION,
  HTTP_REQUEST_TOTAL,
  METRICS_METER_TOKEN,
} from './metrics.constants';

/**
 * One completed HTTP request observation.
 */
export interface RequestObservation {
  /** Normalized route template, never raw URLs or key values. */
  route: string;
  /** Uppercased HTTP method. */
  method: string;
  /** Numeric HTTP status actually sent. */
  statusCode: number;
  /** Handler duration in seconds. */
  durationSec: number;
}

@Injectable()
export class MetricsService {
  private readonly requestsTotal: Counter;
  private readonly requestDuration: Histogram;

  /**
   * Creates the counter and histogram from the shared Meter.
   *
   * @param meter Shared OTel Meter provided under METRICS_METER_TOKEN.
   */
  constructor(@Inject(METRICS_METER_TOKEN) meter: Meter) {
    this.requestsTotal = meter.createCounter(HTTP_REQUEST_TOTAL, {
      description: 'Total completed HTTP requests by route.',
    });
    this.requestDuration = meter.createHistogram(HTTP_REQUEST_DURATION, {
      description: 'HTTP handler duration by route.',
      unit: DURATION_UNIT_SECONDS,
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_SECONDS] },
    });
  }

  /**
   * Records one completed request on both instruments.
   *
   * - no-op for health probes so scrape traffic stays out of route metrics
   * - status is stored as a string to keep cardinality flat.
   *
   * @param observation Completed request labels and duration.
   */
  recordRequest(observation: RequestObservation): void {
    if (isHealthRequest(observation.route)) {
      return;
    }
    const attributes: Attributes = {
      'http.route': observation.route,
      'http.method': observation.method,
      'http.status_code': String(observation.statusCode),
    };
    this.requestsTotal.add(1, attributes);
    this.requestDuration.record(observation.durationSec, attributes);
  }
}
