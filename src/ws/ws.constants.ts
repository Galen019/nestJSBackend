/**
 * WebSocket transport boundary config.
 *
 * - Single source of truth for the inbound `maxPayload` frame limit
 * - `WS_MAX_PAYLOAD_BYTES` overrides the 2 MB default with integer bytes
 * - Fail-closed: throws on non-integer or non-positive values
 * - Owns the oversize error predicate so adapter and service share one check.
 */
import { parseBoundedInt } from '../common/env';

/** Default inbound frame limit applied when `WS_MAX_PAYLOAD_BYTES` is unset. */
export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** Close code the `ws` server sends when a frame exceeds `maxPayload`. */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

/** `ws` error code emitted when a frame exceeds `maxPayload`. */
export const WS_ERR_UNSUPPORTED_MESSAGE_LENGTH =
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

/**
 * Parses a raw `WS_MAX_PAYLOAD_BYTES` value into bytes.
 *
 * - blank/unset returns the 2 MB default
 * - integer bytes only with no upper cap, matching `parseBoundedInt` strictness
 * - throws on non-integer or non-positive values.
 *
 * @param raw Raw env value for the payload limit.
 * @return The validated limit in bytes.
 */
export function parseMaxPayloadBytes(raw: string | undefined): number {
  return parseBoundedInt(raw, {
    defaultValue: DEFAULT_WS_MAX_PAYLOAD_BYTES,
    min: 1,
    label: 'WS_MAX_PAYLOAD_BYTES',
  });
}

/**
 * Loads and validates the WebSocket payload limit.
 *
 * - reads `WS_MAX_PAYLOAD_BYTES` lazily so tests can set env per case
 * - throws on invalid values so the app fails fast instead of running open.
 *
 * @return The validated limit in bytes.
 */
export function getWsMaxPayload(): number {
  return parseMaxPayloadBytes(process.env.WS_MAX_PAYLOAD_BYTES);
}

/**
 * Checks whether a socket error is a transport oversize rejection.
 *
 * - matches the `ws` receiver error code only, the stable driver contract
 * - narrows `unknown` without casts to driver internals.
 *
 * @param err Raw error value from the socket.
 * @return True when the error signals `maxPayload` exceeded.
 */
export function isWsPayloadTooBigError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return 'code' in err && err.code === WS_ERR_UNSUPPORTED_MESSAGE_LENGTH;
}
