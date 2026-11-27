/**
 * Authorizes `/ws` connections and delegates session handling.
 *
 * - claims the client ID cluster-wide before registering a local session
 */

import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { ClusterService } from '../cluster/cluster.service';
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
    private readonly cluster: ClusterService,
  ) {}

  /**
   * Resolves identity, claims the client, and registers authorized sockets.
   *
   * @param client WebSocket instance.
   * @param args Connection arguments, starting with the upgrade request.
   * @return Resolves when the session's tracker fan-out has settled.
   */
  async handleConnection(
    client: SessionSocket,
    ...args: unknown[]
  ): Promise<void> {
    const decision = resolveGatewayIdentity(
      extractGatewayIdentity(args),
      (token: string) => this.verifier.verify(token),
    );
    if (decision.kind === 'rejected') {
      client.close(WS_CLOSE_POLICY_VIOLATION, decision.reason);
      return;
    }
    let claimToken: string | undefined;
    try {
      claimToken = await this.cluster.claimClient(decision.clientId);
    } catch {
      client.close(WS_CLOSE_POLICY_VIOLATION, 'claim failed');
      return;
    }
    if (claimToken === undefined) {
      client.close(WS_CLOSE_POLICY_VIOLATION, 'duplicate clientId');
      return;
    }
    const result = this.wsService.handleConnection({
      socket: client,
      userId: decision.userId,
      clientId: decision.clientId,
      expiresAt: decision.expiresAt,
      claimToken,
    });
    if (result.kind !== 'registered') {
      await this.cluster.releaseClient(decision.clientId, claimToken);
      return;
    }
    await result.pending;
  }
}
