/**
 * WebSocket gateway for the `/ws` endpoint.
 *
 * - Thin adapter: parses `userId`/`clientId`/`token` at the boundary
 * - Verifies the JWT before delegating registry policy to `WsService`
 */

import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import {
  parseClientId,
  parseToken,
  parseUserId,
  type ClientId,
  type SessionSocket,
  type UserId,
} from './session.interface';
import { WS_CLOSE_POLICY_VIOLATION, WsService } from './ws.service';

/**
 * Identity parsed from the WS upgrade URL.
 *
 * - token stays raw; verification happens in `isAuthorized`
 * - kept separate from `ConnectionParams` so raw tokens never reach the registry.
 */
interface GatewayIdentity {
  userId: UserId | undefined;
  clientId: ClientId | undefined;
  token: string | undefined;
}

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
   * - verifies the `token` query param before registering anything
   * - closes with 1008 on missing/invalid tokens or `sub`/`userId` mismatch
   * - delegates validation, duplicate policy, and registration to `WsService`
   * - the service closes the socket with 1008 on missing params or duplicates.
   *
   * @param client Per-connection WebSocket instance.
   * @param args Extra connection args, first entry is the upgrade request.
   */
  handleConnection(client: SessionSocket, ...args: unknown[]): void {
    const { userId, clientId, token } = this.extractIdentity(args);
    if (!this.isAuthorized(client, userId, token)) {
      return;
    }
    this.wsService.handleConnection({ socket: client, userId, clientId });
  }

  /**
   * Verifies the WS token and its binding to `userId`.
   *
   * - closes with 1008 when the token is missing or fails verification
   * - closes with 1008 when `sub` is present but differs from `userId`
   * - returns false after closing, true when the socket may proceed.
   *
   * @param client Socket to close on auth failure.
   * @param userId Parsed `userId` from the upgrade URL.
   * @param token Raw `token` query value from the upgrade URL.
   * @return True when the connection is authorized.
   */
  private isAuthorized(
    client: SessionSocket,
    userId: UserId | undefined,
    token: string | undefined,
  ): boolean {
    if (token === undefined) {
      client.close(WS_CLOSE_POLICY_VIOLATION, 'missing token');
      return false;
    }
    try {
      const payload = this.verifier.verify(token);
      if (
        payload.sub !== undefined &&
        userId !== undefined &&
        payload.sub !== userId
      ) {
        client.close(WS_CLOSE_POLICY_VIOLATION, 'token subject mismatch');
        return false;
      }
    } catch {
      client.close(WS_CLOSE_POLICY_VIOLATION, 'invalid token');
      return false;
    }
    return true;
  }

  /**
   * Extracts `userId`/`clientId`/`token` from the upgrade request.
   *
   * - boundary parse: raw query values become branded ids or undefined
   * - token stays a raw string; verification happens in `isAuthorized`
   * - returns undefined values when no URL is present, caller then closes 1008.
   *
   * @param args Raw connection args from the ws adapter.
   * @return The parsed identity values plus the raw token.
   */
  private extractIdentity(args: unknown[]): GatewayIdentity {
    const request = args[0];
    if (!this.hasUpgradeUrl(request) || request.url === undefined) {
      return { userId: undefined, clientId: undefined, token: undefined };
    }
    try {
      const params = new URL(request.url, 'http://localhost').searchParams;
      return {
        userId: parseUserId(params.get('userId')),
        clientId: parseClientId(params.get('clientId')),
        token: parseToken(params.get('token')),
      };
    } catch {
      return { userId: undefined, clientId: undefined, token: undefined };
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
    if (typeof value !== 'object' || value === null || !('url' in value)) {
      return false;
    }
    const url = value.url;
    return url === undefined || typeof url === 'string';
  }
}
