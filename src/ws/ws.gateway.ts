/**
 * WebSocket gateway for the `/ws` endpoint.
 *
 * - Thin adapter: parses `userId`/`clientId` into branded ids at the boundary
 * - Delegates all registry policy to `WsService`
 */

import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import {
  parseClientId,
  parseUserId,
  type ConnectionParams,
  type SessionSocket,
} from './session.interface';
import { WsService } from './ws.service';

/**
 * Gateway bound to path `/ws` on the underlying HTTP server.
 *
 * - `handleConnection` associates each socket with its `ClientId` via the service
 * - the service owns the full session lifecycle, including `close` cleanup
 * - inbound `message`/`error` frames are observed by service listeners.
 */
@WebSocketGateway({ path: '/ws' })
export class WsGateway implements OnGatewayConnection {
  constructor(private readonly wsService: WsService) {}

  /**
   * Associates a new socket with its `ClientId` session.
   *
   * - extracts and parses `userId`/`clientId` from the upgrade request URL
   * - delegates validation, duplicate policy, and registration to `WsService`
   * - the service closes the socket with 1008 on missing params or duplicates.
   *
   * @param client Per-connection WebSocket instance.
   * @param args Extra connection args, first entry is the upgrade request.
   */
  handleConnection(client: SessionSocket, ...args: unknown[]): void {
    const { userId, clientId } = this.extractIdentity(args);
    this.wsService.handleConnection({ socket: client, userId, clientId });
  }

  /**
   * Extracts `userId`/`clientId` from the upgrade request.
   *
   * - boundary parse: raw query values become branded ids or undefined
   * - returns undefined values when no URL is present, service then closes 1008.
   *
   * @param args Raw connection args from the ws adapter.
   * @return The parsed identity values.
   */
  private extractIdentity(
    args: unknown[],
  ): Pick<ConnectionParams, 'userId' | 'clientId'> {
    const request = args[0];
    if (!this.hasUpgradeUrl(request) || request.url === undefined) {
      return { userId: undefined, clientId: undefined };
    }
    try {
      const params = new URL(request.url, 'http://localhost').searchParams;
      return {
        userId: parseUserId(params.get('userId')),
        clientId: parseClientId(params.get('clientId')),
      };
    } catch {
      return { userId: undefined, clientId: undefined };
    }
  }

  /**
   * Checks that a value carries an upgrade URL.
   *
   * - verifies the full claimed shape: object with a string-or-undefined `url`
   * - narrows `unknown` adapter args without casts.
   *
   * @param value Candidate upgrade request value.
   * @return True when the value has a usable URL field.
   */
  private hasUpgradeUrl(value: unknown): value is { url?: string } {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('url' in value)
    ) {
      return false;
    }
    const url = value.url;
    return url === undefined || typeof url === 'string';
  }
}
