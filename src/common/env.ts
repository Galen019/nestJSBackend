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
