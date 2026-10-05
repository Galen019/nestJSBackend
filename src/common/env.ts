/**
 * Canonical parsing for strict opt-in env flags.
 *
 * - single owner of the `true`/`1`/`yes` truthy set shared by bootstrap gates
 * - missing, blank, and unrecognized values are false so a typo cannot enable
 *   a gate; gates needing default-true or warn-on-unknown semantics layer
 *   that on top (see `tracing.parseEnabled`).
 */

/**
 * Parses a strict opt-in env flag.
 *
 * - trims and lowercases before comparing against the truthy set
 * - missing, blank, and unrecognized values are false.
 *
 * @param value Raw env value.
 * @return True only for `true`/`1`/`yes`.
 */
export function parseEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
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
