/**
 * Best-effort WebSocket presence writer for DynamoDB.
 *
 * - owns all `User`/`Clients` PutItem/DeleteItem calls plus TTL math
 * - called from `WsService` only on registered connects and on socket close
 * - Dynamo failures are logged and swallowed so presence can never reject a
 *   tracker fan-out; `WsService` additionally isolates every tracker, so a
 *   bug here still cannot stall siblings
 * - `User` rows are permanent by design (no TTL, no delete); `Clients` rows
 *   carry `expiresAt` (1 day) as a crash-safety net behind explicit deletes
 * - each connect mints a per-connection `presenceToken` mirrored into its
 *   `Clients` row; disconnects delete conditionally on that token, so a slow
 *   delete landing after a fast reconnect on the same `clientId` fails its
 *   condition and leaves the fresh row intact.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { isAwsError } from '../common/aws-error';
import { DynamoService } from '../dynamo/dynamo.service';
import { buildExpiresAt, CLIENT_PRESENCE_TTL_SECONDS } from '../dynamo/ttl';
import type {
  ClientId,
  SessionLifecycleEvent,
  SessionTracker,
  UserId,
} from '../ws/session.interface';

/**
 * Writes WS presence to the `User` and `Clients` tables, best-effort.
 *
 * - `trackConnect` upserts both rows; `trackDisconnect` removes the client row
 * - disconnects are conditional on the connect-time token when provided
 * - both resolve even when Dynamo is unreachable
 * - implements `SessionTracker` so `WsService` fans lifecycle out to it.
 */
@Injectable()
export class PresenceService implements SessionTracker {
  private readonly logger = new Logger(PresenceService.name);

  /**
   * Creates the service with the DynamoDB lifecycle wrapper.
   *
   * @param dynamo Lifecycle wrapper exposing the shared DynamoDB client.
   */
  constructor(private readonly dynamo: DynamoService) {}

  /**
   * Records a fanned-out session connect in DynamoDB.
   *
   * - awaits `trackConnect`, which swallows Dynamo failures internally.
   *
   * @param event Session identity for the new connection.
   * @return Resolves when the connect has been observed.
   */
  handleConnect(event: SessionLifecycleEvent): Promise<void> {
    return this.trackConnect(event.userId, event.clientId, event.token);
  }

  /**
   * Removes a fanned-out session disconnect from DynamoDB.
   *
   * - awaits `trackDisconnect`, which swallows Dynamo failures internally.
   *
   * @param event Session identity for the closed connection.
   * @return Resolves when the disconnect has been observed.
   */
  handleDisconnect(event: SessionLifecycleEvent): Promise<void> {
    return this.trackDisconnect(event.clientId, event.token);
  }

  /**
   * Records a newly registered connection in DynamoDB.
   *
   * - upserts `User { userId }` (permanent registry) and
   *   `Clients { clientId, userId, expiresAt, presenceToken }` concurrently;
   *   `expiresAt` is now plus the 1-day presence lifetime in epoch seconds
   * - the token lets the matching disconnect delete conditionally so stale
   *   closes cannot remove reconnected rows
   * - both writes settle via `allSettled` so each is attempted even when the
   *   other fails, then failures are logged and swallowed so callers resolve.
   *
   * @param userId Owner of the connection.
   * @param clientId Unique session key that connected.
   * @param presenceToken Per-connection token minted by the session registry.
   * @return Resolves when the writes settle or fail gracefully.
   */
  async trackConnect(
    userId: UserId,
    clientId: ClientId,
    presenceToken: string,
  ): Promise<void> {
    const client = this.dynamo.getClient();
    const expiresAt = buildExpiresAt(CLIENT_PRESENCE_TTL_SECONDS);
    const results = await Promise.allSettled([
      client.send(
        new PutItemCommand({
          TableName: 'User',
          Item: { userId: { S: userId } },
        }),
      ),
      client.send(
        new PutItemCommand({
          TableName: 'Clients',
          Item: {
            clientId: { S: clientId },
            userId: { S: userId },
            expiresAt: { N: String(expiresAt) },
            presenceToken: { S: presenceToken },
          },
        }),
      ),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        const detail =
          result.reason instanceof Error
            ? result.reason.message
            : 'unknown error';
        this.logger.warn(`Failed to track connect: ${detail} ${clientId}`);
      }
    }
  }

  /**
   * Removes a disconnected client from DynamoDB.
   *
   * - deletes the `Clients` row by `clientId` PK, idempotent when missing
   * - deletes only when the stored token matches, so a stale close racing a
   *   reconnect leaves the fresh row intact; the resulting
   *   `ConditionalCheckFailedException` is an expected benign outcome,
   *   logged without warn-level alarm
   * - `User` rows are intentionally left behind (permanent registry)
   * - logs and swallows Dynamo failures so callers resolve.
   *
   * @param clientId Unique session key that disconnected.
   * @param presenceToken Token minted at connect time, matched conditionally.
   * @return Resolves when the delete settles or fails gracefully.
   */
  async trackDisconnect(
    clientId: ClientId,
    presenceToken: string,
  ): Promise<void> {
    try {
      const client = this.dynamo.getClient();
      await client.send(
        new DeleteItemCommand({
          TableName: 'Clients',
          Key: { clientId: { S: clientId } },
          ConditionExpression: 'presenceToken = :token',
          ExpressionAttributeValues: { ':token': { S: presenceToken } },
        }),
      );
    } catch (err: unknown) {
      if (isAwsError(err, 'ConditionalCheckFailedException')) {
        this.logger.log(
          `Ignoring stale disconnect for ${clientId}: presence row was reconnected`,
        );
        return;
      }
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`Failed to track disconnect: ${detail} ${clientId}`);
    }
  }
}
