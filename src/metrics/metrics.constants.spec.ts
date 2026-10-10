/**
 * Unit suite for metrics identity constants.
 *
 * - asserts stable instrument names and meter wiring
 * - asserts histogram buckets are positive and sorted.
 */
import { describe, it, expect } from 'vitest';
import {
  DURATION_BUCKETS_SECONDS,
  DURATION_UNIT_SECONDS,
  HTTP_REQUEST_DURATION,
  HTTP_REQUEST_TOTAL,
  METRICS_METER_NAME,
  METRICS_METER_TOKEN,
} from './metrics.constants';

describe('metrics constants', () => {
  it('exposes stable instrument and provider identity', () => {
    expect(METRICS_METER_NAME).toBe('production-backend');
    expect(METRICS_METER_TOKEN).toBe('METRICS_METER');
    expect(HTTP_REQUEST_TOTAL).toBe('http.request.total');
    expect(HTTP_REQUEST_DURATION).toBe('http.request.duration');
    expect(DURATION_UNIT_SECONDS).toBe('s');
  });

  it('keeps histogram buckets positive and sorted', () => {
    expect(DURATION_BUCKETS_SECONDS.length).toBeGreaterThan(0);
    const sorted = [...DURATION_BUCKETS_SECONDS].sort((a, b) => a - b);
    expect([...DURATION_BUCKETS_SECONDS]).toEqual(sorted);
    for (const bucket of DURATION_BUCKETS_SECONDS) {
      expect(bucket).toBeGreaterThan(0);
    }
  });
});
