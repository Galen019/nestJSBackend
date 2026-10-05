/**
 * Unit suite for WsServerAdapter construction and error policy.
 *
 * - default: `create()` injects the 2 MB limit when no option is given
 * - env: `WS_MAX_PAYLOAD_BYTES` override flows through to the `ws` server
 * - precedence: the resolved limit forces over any incoming `maxPayload`
 * - omitted options: `create(port)` still injects the limit
 * - fail-closed: invalid env throws instead of running open
 * - errors: oversize socket errors stay silent here, others log at error.
 */
import { Logger } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { type Server as WsServer } from 'ws';
import { WsServerAdapter } from './ws.adapter';
import {
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  WS_ERR_UNSUPPORTED_MESSAGE_LENGTH,
} from './ws.constants';

describe('WsServerAdapter', () => {
  let previous: string | undefined;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previous = process.env.WS_MAX_PAYLOAD_BYTES;
    delete process.env.WS_MAX_PAYLOAD_BYTES;
    createSpy = vi.spyOn(WsAdapter.prototype, 'create').mockReturnValue({});
  });

  afterEach(() => {
    createSpy.mockRestore();
    vi.restoreAllMocks();
    if (previous === undefined) {
      delete process.env.WS_MAX_PAYLOAD_BYTES;
    } else {
      process.env.WS_MAX_PAYLOAD_BYTES = previous;
    }
  });

  it('injects the default limit when no maxPayload is given', () => {
    const adapter = new WsServerAdapter();

    adapter.create(0, { path: '/ws' });

    expect(createSpy).toHaveBeenCalledWith(0, {
      path: '/ws',
      maxPayload: DEFAULT_WS_MAX_PAYLOAD_BYTES,
    });
  });

  it('passes the env override through to the ws server', () => {
    process.env.WS_MAX_PAYLOAD_BYTES = '1048576';
    const adapter = new WsServerAdapter();

    adapter.create(0, { path: '/ws' });

    expect(createSpy).toHaveBeenCalledWith(0, {
      path: '/ws',
      maxPayload: 1048576,
    });
  });

  it('forces the resolved limit over any incoming maxPayload', () => {
    const adapter = new WsServerAdapter();

    adapter.create(0, { path: '/ws', maxPayload: 999 });

    expect(createSpy).toHaveBeenCalledWith(0, {
      path: '/ws',
      maxPayload: DEFAULT_WS_MAX_PAYLOAD_BYTES,
    });
  });

  it('injects the limit when options are omitted entirely', () => {
    const adapter = new WsServerAdapter();

    adapter.create(0);

    expect(createSpy).toHaveBeenCalledWith(0, {
      maxPayload: DEFAULT_WS_MAX_PAYLOAD_BYTES,
    });
  });

  it('throws on invalid env instead of running open', () => {
    process.env.WS_MAX_PAYLOAD_BYTES = 'abc';
    const adapter = new WsServerAdapter();

    expect(() => adapter.create(0, { path: '/ws' })).toThrow(
      'Invalid WS_MAX_PAYLOAD_BYTES: abc',
    );
  });

  it('silences oversize socket errors owned by the service', () => {
    const adapter = new WsServerAdapter();
    const socketErrors = new Map<string, (err: unknown) => void>();
    const fakeWs = {
      on: vi.fn((event: string, listener: (err: unknown) => void) => {
        socketErrors.set(event, listener);
      }),
    };
    const server = {
      on: vi.fn((event: string, listener: (ws: unknown) => void) => {
        if (event === 'connection') {
          listener(fakeWs);
        }
        return server;
      }),
    };
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    adapter.bindErrorHandler(server as unknown as WsServer);
    const oversize = new RangeError('Max payload size exceeded');
    Object.assign(oversize, { code: WS_ERR_UNSUPPORTED_MESSAGE_LENGTH });
    socketErrors.get('error')?.(oversize);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs non-oversize socket and server errors at error level', () => {
    const adapter = new WsServerAdapter();
    const socketErrors = new Map<string, (err: unknown) => void>();
    const serverErrors = new Map<string, (err: unknown) => void>();
    const fakeWs = {
      on: vi.fn((event: string, listener: (err: unknown) => void) => {
        socketErrors.set(event, listener);
      }),
    };
    const server = {
      on: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'connection') {
          (listener as (ws: unknown) => void)(fakeWs);
        }
        if (event === 'error') {
          serverErrors.set(event, listener);
        }
        return server;
      }),
    };
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    adapter.bindErrorHandler(server as unknown as WsServer);
    socketErrors.get('error')?.(new Error('boom'));
    serverErrors.get('error')?.(new Error('server boom'));

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
