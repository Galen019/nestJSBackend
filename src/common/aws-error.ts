/**
 * Canonical AWS SDK error narrowing.
 *
 * - single owner of the `name`/`code` exception match shared by DynamoDB callers
 * - SDK faults vary by path, so both fields are checked; non-objects never match.
 */

/**
 * Checks whether an SDK error carries the given exception name.
 *
 * - matches against both `name` and `code` because SDK faults vary by path
 * - non-object failures never match.
 *
 * @param err Unknown client failure.
 * @param code Exception name to match.
 * @return True when the error matches by name or code.
 */
export function isAwsError(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const record = err as { name?: unknown; code?: unknown };
  return record.name === code || record.code === code;
}
