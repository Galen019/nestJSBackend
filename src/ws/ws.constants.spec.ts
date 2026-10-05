/**
 * Unit suite for the WebSocket transport boundary config.
 *
 * - default: unset/blank env returns the 2 MB default
 * - accept: integer bytes with no upper cap, including very large values
 * - reject: non-integer, non-positive, or non-numeric values throw
 * - predicate: only the `ws` error code signals oversize, nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  WS_ERR_UNSUPPORTED_MESSAGE_LENGTH,
  getWsMaxPayload,
  isWsPayloadTooBigError,
  parseMaxPayloadBytes,
} from './ws.constants';

describe('ws.constants', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.WS_MAX_PAYLOAD_BYTES;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.WS_MAX_PAYLOAD_BYTES;
    } else {
      process.env.WS_MAX_PAYLOAD_BYTES = previous;
    }
  });

  it('returns the 2 MB default when the env var is unset', () => {
    delete process.env.WS_MAX_PAYLOAD_BYTES;

    expect(getWsMaxPayload()).toBe(DEFAULT_WS_MAX_PAYLOAD_BYTES);
    expect(DEFAULT_WS_MAX_PAYLOAD_BYTES).toBe(2 * 1024 * 1024);
  });

  it('returns the default when the env var is blank', () => {
    expect(parseMaxPayloadBytes('')).toBe(DEFAULT_WS_MAX_PAYLOAD_BYTES);
  });

  it('accepts integer bytes with no upper cap', () => {
    expect(parseMaxPayloadBytes('2097152')).toBe(2097152);
    expect(parseMaxPayloadBytes('200000000')).toBe(200000000);
  });

  it('reads the env override through getWsMaxPayload', () => {
    process.env.WS_MAX_PAYLOAD_BYTES = '1048576';

    expect(getWsMaxPayload()).toBe(1048576);
  });

  it.each(['0', '-1', '1.5', 'abc', '2MB', ' '])(
    'rejects invalid value %p',
    (raw: string) => {
      expect(() => parseMaxPayloadBytes(raw)).toThrow(
        `Invalid WS_MAX_PAYLOAD_BYTES: ${raw}`,
      );
    },
  );

  it('detects oversize errors by code only', () => {
    const oversize = new RangeError('Max payload size exceeded');
    Object.assign(oversize, { code: WS_ERR_UNSUPPORTED_MESSAGE_LENGTH });

    expect(isWsPayloadTooBigError(oversize)).toBe(true);
    expect(isWsPayloadTooBigError(new Error('boom'))).toBe(false);
    expect(isWsPayloadTooBigError(new Error('Max payload size exceeded'))).toBe(
      false,
    );
    expect(isWsPayloadTooBigError('boom')).toBe(false);
  });
});
