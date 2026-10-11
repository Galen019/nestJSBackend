/**
 * Unit suite for the canonical health probe paths and matcher.
 *
 * - constants stay in sync with the mounted probe routes
 * - matcher accepts live/ready with query or trailing slashes, rejects the rest.
 */
import { describe, it, expect } from 'vitest';
import {
  HEALTH_BASE_PATH,
  HEALTH_PROBE_PATHS,
  LIVE_PATH,
  LIVE_SUBPATH,
  READY_PATH,
  READY_SUBPATH,
  isHealthRequest,
} from './health.constants';

describe('health probe constants', () => {
  it('mounts live and ready below the shared base', () => {
    expect(`/${HEALTH_BASE_PATH}/${LIVE_SUBPATH}`).toBe(LIVE_PATH);
    expect(`/${HEALTH_BASE_PATH}/${READY_SUBPATH}`).toBe(READY_PATH);
    expect([...HEALTH_PROBE_PATHS].sort()).toEqual(
      [LIVE_PATH, READY_PATH].sort(),
    );
  });
});

describe('isHealthRequest', () => {
  it('matches live and ready probes with query or trailing slashes', () => {
    expect(isHealthRequest('/health/live')).toBe(true);
    expect(isHealthRequest('/health/live/')).toBe(true);
    expect(isHealthRequest('/health/live?full=1')).toBe(true);
    expect(isHealthRequest('/health/ready')).toBe(true);
    expect(isHealthRequest('/health/ready/')).toBe(true);
    expect(isHealthRequest('/health/ready?full=1')).toBe(true);
  });

  it('rejects bare health paths, unknown subpaths, and odd input', () => {
    expect(isHealthRequest('/health')).toBe(false);
    expect(isHealthRequest('/health/')).toBe(false);
    expect(isHealthRequest('/health/details')).toBe(false);
    expect(isHealthRequest('/healthz')).toBe(false);
    expect(isHealthRequest('/api/health')).toBe(false);
    expect(isHealthRequest('/')).toBe(false);
    expect(isHealthRequest('/redis?key=a')).toBe(false);
    expect(isHealthRequest(undefined)).toBe(false);
    expect(isHealthRequest('')).toBe(false);
    expect(isHealthRequest(':::')).toBe(false);
  });
});
