/**
 * Canonical parsing for env flags and bounded integers.
 *
 * - single owner of the `true`/`1`/`yes` truthy set shared by every gate
 * - `parseEnvFlag` covers both opt-in flags (default false, unknown silent)
 *   and default-on gates (default true, warn on unknown) via options, so no
 *   caller maintains a second truthy set.
 */

/**
 * Values that enable a flag, compared case-insensitively after trimming.
 */
const ENABLED_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

/**
 * Values that explicitly disable a flag, compared case-insensitively.
 */
const DISABLED_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no']);

/**
 * Tuning knobs for `parseEnvFlag`.
 */
export interface EnvFlagOptions {
  /**
   * Returned for missing, blank, and unrecognized values.
   *
   * - defaults to false so a typo cannot enable an opt-in gate
   * - default-on gates pass true and layer warn-on-unknown on top.
   */
  defaultValue?: boolean;
  /**
   * Warns via `console.warn` on unrecognized values instead of staying silent.
   *
   * - defaults to false; default-on gates enable it so a typo cannot
   *   silently flip one environment while others stay enabled.
   */
  warnOnUnknown?: boolean;
  /**
   * Env name used in the warn message, required when `warnOnUnknown` is set.
   */
  label?: string;
}

/**
 * Parses an env flag with fail-explicit semantics.
 *
 * - trims and lowercases before comparing against the truthy/falsy sets
 * - missing, blank, and unrecognized values return `defaultValue`.
 *
 * @param value Raw env value.
 * @param options Default for absent/unknown input plus warn behavior.
 * @return True only for `true`/`1`/`yes`, unless defaulted otherwise.
 */
export function parseEnvFlag(
  value: string | undefined,
  options: EnvFlagOptions = {},
): boolean {
  const { defaultValue = false, warnOnUnknown = false, label } = options;
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '') {
    return defaultValue;
  }
  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }
  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }
  if (warnOnUnknown) {
    const detail = label === undefined ? 'flag' : label;
    console.warn(
      `[env] unknown ${detail} "${value}", defaulting to ${defaultValue ? 'enabled' : 'disabled'}`,
    );
  }
  return defaultValue;
}

/**
 * Bounds for a shared integer env parser.
 *
 * - `defaultValue` is returned for missing or empty input
 * - `min` is the smallest accepted integer
 * - `max` is omitted for unbounded values, set to cap the range
 * - `label` is the env name used in the fail-closed error message.
 */
export interface BoundedIntOptions {
  defaultValue: number;
  min: number;
  max?: number;
  label: string;
}

/**
 * Parses a bounded integer env value with fail-closed semantics.
 *
 * - missing or empty input returns the default
 * - integer values only, no suffix parsing
 * - throws when non-integer, below `min`, or above `max`.
 *
 * @param raw Raw env value.
 * @param options Default, bounds, and label for the error message.
 * @return The validated integer.
 */
export function parseBoundedInt(
  raw: string | undefined,
  options: BoundedIntOptions,
): number {
  if (raw === undefined || raw === '') {
    return options.defaultValue;
  }
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < options.min ||
    (options.max !== undefined && parsed > options.max)
  ) {
    throw new Error(`Invalid ${options.label}: ${raw}`);
  }
  return parsed;
}
