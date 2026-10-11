/**
 * Canonical health probe paths shared by controllers, metrics, and tracing.
 *
 * - Single owner of the liveness and readiness route strings
 * - Exclusion helpers match only live/ready; bare `/health` is not a probe.
 */

/** Base path for health controllers (no leading slash for Nest). */
export const HEALTH_BASE_PATH = 'health';

/** Liveness subpath below the health base. */
export const LIVE_SUBPATH = 'live';

/** Readiness subpath below the health base. */
export const READY_SUBPATH = 'ready';

/** URL prefix for health probes with a leading slash. */
const HEALTH_PREFIX = '/health';

/** Full liveness probe path. */
export const LIVE_PATH = `${HEALTH_PREFIX}/${LIVE_SUBPATH}`;

/** Full readiness probe path. */
export const READY_PATH = `${HEALTH_PREFIX}/${READY_SUBPATH}`;

/** Exact probe paths excluded from metrics and tracing. */
export const HEALTH_PROBE_PATHS: readonly string[] = [LIVE_PATH, READY_PATH];

/**
 * Checks whether a URL targets a health probe (live or ready only).
 *
 * - ignores query strings, fragments, and trailing slashes
 * - bare `/health` and unknown subpaths return false.
 *
 * @param url Request URL or path, if known.
 * @return Whether it targets a health probe.
 */
export function isHealthRequest(url: string | undefined): boolean {
  if (url === undefined || url === '') {
    return false;
  }
  try {
    const path = new URL(url, 'http://localhost').pathname;
    const normalized = path.replace(/\/+$/, '') || '/';
    return HEALTH_PROBE_PATHS.includes(normalized);
  } catch {
    return false;
  }
}
