/** Shared parsers for environment flags and bounded integers. */

/** Case-insensitive values that enable a flag. */
const ENABLED_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

/** Case-insensitive values that disable a flag. */
const DISABLED_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no']);

/** Options for `parseEnvFlag`. */
export interface EnvFlagOptions {
  /**
   * Value for missing, blank, or unrecognized input; defaults to false.
   */
  defaultValue?: boolean;
  /**
   * Warn on unrecognized values; defaults to false.
   */
  warnOnUnknown?: boolean;
  /**
   * Environment name included in warnings.
   */
  label?: string;
}

/**
 * Parses a flag, using the configured default for missing or unknown values.
 *
 * @param value Raw env value.
 * @param options Default and warning behavior.
 * @return Parsed flag value.
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

/** Options and bounds for `parseBoundedInt`. */
export interface BoundedIntOptions {
  defaultValue: number;
  min: number;
  max?: number;
  label: string;
}

/**
 * Parses an integer within the configured bounds or throws.
 *
 * @param raw Raw env value.
 * @param options Default value, bounds, and error label.
 * @return Validated integer.
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
