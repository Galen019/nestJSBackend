/**
 * Test-only WS identity parsers (no casts in specs).
 *
 * - single owner of the fail-fast branded-id helpers for WS suites
 * - literals in specs are always valid, so a bad one fails the test loudly.
 */
import {
  parseClientId,
  parseUserId,
  type ClientId,
  type UserId,
} from '../src/ws/session.interface';

/**
 * Parses a test `userId`, failing fast on bad literals.
 *
 * @param value Literal user id used by the test.
 * @return The branded user id.
 */
export function requireUserId(value: string): UserId {
  const parsed = parseUserId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test userId: ${value}`);
  }
  return parsed;
}

/**
 * Parses a test `clientId`, failing fast on bad literals.
 *
 * @param value Literal client id used by the test.
 * @return The branded client id.
 */
export function requireClientId(value: string): ClientId {
  const parsed = parseClientId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test clientId: ${value}`);
  }
  return parsed;
}
