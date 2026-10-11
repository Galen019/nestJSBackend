/**
 * Unit suite for the metrics env config and shared metadata.
 *
 * - enabled toggle defaults, explicit values, and warn-on-garbage
 * - fixed scrape port and path contract.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  METRICS_PATH,
  METRICS_PORT,
  getMetricsConfig,
} from './metrics.constants';

describe('metrics enabled toggle', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('is enabled by default', () => {
    delete process.env.METRICS_ENABLED;

    expect(getMetricsConfig().enabled).toBe(true);
  });

  it('is disabled by explicit values', () => {
    for (const raw of ['false', 'FALSE', '0', 'no']) {
      process.env.METRICS_ENABLED = raw;

      expect(getMetricsConfig().enabled).toBe(false);
    }
  });

  it('warns and stays enabled on garbage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.METRICS_ENABLED = 'bogus';

    expect(getMetricsConfig().enabled).toBe(true);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('bogus');
  });
});

describe('metrics scrape contract', () => {
  it('serves the fixed port and path', () => {
    expect(METRICS_PORT).toBe(9464);
    expect(METRICS_PATH).toBe('/metrics');
  });
});
