/**
 * WebSocket server adapter enforcing the transport payload limit.
 *
 * - Subclasses Nest's `WsAdapter` so `maxPayload` reaches the `ws` server
 * - Single owner of the `ws` construction policy for `/ws`
 * - Forces the resolved limit over any incoming option, one decision point
 * - Filters oversize socket errors so `WsService` stays the single owner
 *   of socket error logging; only server-level errors log here.
 */
import { WsAdapter } from '@nestjs/platform-ws';
import { type Server as WsServer } from 'ws';
import { getWsMaxPayload, isWsPayloadTooBigError } from './ws.constants';

/**
 * `WsAdapter` with an enforced `maxPayload` transport boundary.
 *
 * - `create()` injects the validated limit so oversize frames close with 1009
 *   before gateway or service handlers ever see them
 * - `bindErrorHandler()` silences oversize socket errors already owned by
 *   the service warn path, server errors still log at error level.
 */
export class WsServerAdapter extends WsAdapter {
  /**
   * Creates the underlying `ws` server with the enforced payload limit.
   *
   * - resolves the limit per call so env changes apply on the next `create`
   * - spreads incoming options first, then forces `maxPayload` to win.
   *
   * @param args Port and gateway options forwarded by Nest.
   * @return The `ws` server instance.
   */
  override create(
    ...args: Parameters<WsAdapter['create']>
  ): ReturnType<WsAdapter['create']> {
    const [port, options] = args;
    const maxPayload = getWsMaxPayload();
    return super.create(port, { ...options, maxPayload });
  }

  /**
   * Binds filtered error handlers to the `ws` server.
   *
   * - per-socket errors skip the oversize code owned by the service warn
   *   path, so one frame never logs as both error and warn
   * - server-level errors log at error level as before.
   *
   * @param server `ws` server created in `create()`.
   * @return The same server with handlers attached.
   */
  override bindErrorHandler(server: WsServer): WsServer {
    server.on('connection', (ws) => {
      ws.on('error', (err: unknown) => {
        if (!isWsPayloadTooBigError(err)) {
          this.logger.error(err);
        }
      });
    });
    server.on('error', (err: unknown) => {
      this.logger.error(err);
    });
    return server;
  }
}
