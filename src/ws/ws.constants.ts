/**
 * WebSocket payload limit configuration and oversize-error detection.
 */
import { parseBoundedInt } from '../common/env';

/** Default inbound frame limit (2 MB). */
export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** WebSocket close code for oversized frames. */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

/** `ws` error code for oversized frames. */
export const WS_ERR_UNSUPPORTED_MESSAGE_LENGTH =
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

/**
 * Parses a positive integer payload limit, defaulting when unset.
 *
 * @param raw Environment value to parse.
 * @return Payload limit in bytes.
 */
export function parseMaxPayloadBytes(raw: string | undefined): number {
  return parseBoundedInt(raw, {
    defaultValue: DEFAULT_WS_MAX_PAYLOAD_BYTES,
    min: 1,
    label: 'WS_MAX_PAYLOAD_BYTES',
  });
}

/**
 * Reads and validates `WS_MAX_PAYLOAD_BYTES`.
 *
 * @return Payload limit in bytes.
 */
export function getWsMaxPayload(): number {
  return parseMaxPayloadBytes(process.env.WS_MAX_PAYLOAD_BYTES);
}

/**
 * Checks whether an error indicates an oversized frame.
 *
 * @param err Error value to check.
 * @return Whether the payload limit was exceeded.
 */
export function isWsPayloadTooBigError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return 'code' in err && err.code === WS_ERR_UNSUPPORTED_MESSAGE_LENGTH;
}
