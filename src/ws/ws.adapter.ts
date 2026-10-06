import { WsAdapter } from '@nestjs/platform-ws';
import { type Server as WsServer } from 'ws';
import { getWsMaxPayload, isWsPayloadTooBigError } from './ws.constants';

/**
 * `WsAdapter` that enforces the payload limit and logs server errors.
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
