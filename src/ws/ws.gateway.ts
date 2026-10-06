/**
 * WebSocket gateway for the `/ws` endpoint.
 *
 * - Thin adapter: resolves the upgrade identity to one authorize/reject
 *   decision, closes once on reject, delegates to `WsService` on authorize
 * - `WsService` owns duplicate policy and registration; this gateway never
 *   duplicates its closes.
 */

import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import {
  extractGatewayIdentity,
  resolveGatewayIdentity,
  type SessionSocket,
} from './session.interface';
import { WS_CLOSE_POLICY_VIOLATION, WsService } from './ws.service';

/**
 * Gateway bound to path `/ws` on the underlying HTTP server.
 *
 * - `handleConnection` associates each socket with its `ClientId` via the service
 * - the service owns the full session lifecycle, including `close` cleanup
 * - inbound `message`/`error` frames are observed by service listeners.
 */
@WebSocketGateway({ path: '/ws' })
export class WsGateway implements OnGatewayConnection {
  constructor(
    private readonly wsService: WsService,
    private readonly verifier: JwtVerifierService,
  ) {}

  /**
   * Associates a new socket with its `ClientId` session.
   *
   * - resolves the upgrade identity to one decision: reject closes once with
   *   1008 carrying the reason, authorize delegates to `WsService`
   * - tokens require a `sub` bound to `userId`; anonymous tokens never claim
   *   an identity.
   *
   * @param client Per-connection WebSocket instance.
   * @param args Extra connection args, first entry is the upgrade request.
   */
  handleConnection(client: SessionSocket, ...args: unknown[]): void {
    const decision = resolveGatewayIdentity(
      extractGatewayIdentity(args),
      (token: string) => this.verifier.verify(token),
    );
    if (decision.kind === 'rejected') {
      client.close(WS_CLOSE_POLICY_VIOLATION, decision.reason);
      return;
    }
    this.wsService.handleConnection({
      socket: client,
      userId: decision.userId,
      clientId: decision.clientId,
    });
  }
}
