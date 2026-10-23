/**
 * Authorizes `/ws` connections and delegates session handling.
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
 * WebSocket gateway bound to `/ws`.
 */
@WebSocketGateway({ path: '/ws' })
export class WsGateway implements OnGatewayConnection {
  constructor(
    private readonly wsService: WsService,
    private readonly verifier: JwtVerifierService,
  ) {}

  /**
   * Resolves identity and registers authorized sockets.
   *
   * @param client WebSocket instance.
   * @param args Connection arguments, starting with the upgrade request.
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
      expiresAt: decision.expiresAt,
    });
  }
}
