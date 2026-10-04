/**
 * In-memory WebSocket session registry with DynamoDB presence tracking.
 *
 * - Owns the `sessions` map keyed by branded `ClientId`
 * - Handles duplicate policy, lifecycle cleanup, and sends
 *   the serialized payload size via the `bytes` field below
 * - Delegates presence to `PresenceService` best-effort: registered connects
 *   upsert `User`/`Clients` rows, socket close deletes the `Clients` row.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PresenceService } from '../presence/presence.service';
import type { ClientId, ConnectionParams, Session } from './session.interface';

/** Close code for policy violations (missing params, duplicate clientId). */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** Maximum characters of an inbound payload written to the log. */
const MAX_LOGGED_PAYLOAD_CHARS = 500;

/**
 * Outcome of attempting to register a new session.
 *
 * - Discriminated union so impossible states cannot be represented
 * - `duplicate` keeps the existing session and closes the new socket
 * - `rejected` closes the socket without registering anything.
 */
export type RegisterSessionResult =
  { kind: 'registered' } | { kind: 'duplicate' } | { kind: 'rejected' };

/**
 * Outcome counts for one fan-out.
 *
 * - `sent`/`skipped` count reachable vs missing/closed recipients
 * - `bytes` is the serialized JSON payload size, reported so the push path
 *   can trace payload sizes without re-serializing.
 */
export interface FanOutResult {
  sent: number;
  skipped: number;
  bytes: number;
}

/**
 * Registry mapping `ClientId` to its live WebSocket session.
 *
 * - Trusts branded ids, they were validated once at the boundary
 * - Duplicate policy: reject the NEW connection, keep the existing session
 * - Each registration closes over its session, so the socket removes its own
 *   entry on `close` with no reverse lookup structure
 * - Presence writes happen only on `registered`; `duplicate`/`rejected` do
 *   zero Dynamo I/O so refused connections never refresh presence rows
 * - Each session mints a `presenceToken` mirrored into its presence row;
 *   the close handler deletes conditionally on that token, so a slow
 *   disconnect landing after a fast reconnect on the same `clientId`
 *   cannot remove the fresh row.
 */
@Injectable()
export class WsService {
  private readonly logger = new Logger(WsService.name);
  private readonly sessions = new Map<ClientId, Session>();

  /**
   * Creates the registry with its presence writer.
   *
   * @param presence Best-effort DynamoDB writer for `User`/`Clients` rows.
   */
  constructor(private readonly presence: PresenceService) {}

  /**
   * Registers a new connection as a session.
   *
   * - closes with 1008 when `userId`/`clientId` are undefined
   * - closes the NEW socket with 1008 when `clientId` already exists, old kept
   * - otherwise stores `{ sequenceNumber: 0, heartbeatAt: Date.now() }`
   *   with a fresh `presenceToken` for the conditional presence delete
   * - fire-and-forget presence upsert after registration; Dynamo failures
   *   never block the socket because `PresenceService` swallows them
   * - attaches `message`/`error` listeners for lifecycle coverage, plus a
   *   `close` listener that removes the session and conditionally deletes the
   *   presence row by token, so disconnected clients never linger while
   *   stale closes never remove a reconnected row.
   *
   * @param params Connection socket plus boundary-parsed ids.
   * @return Discriminated outcome of the registration attempt.
   */
  handleConnection(params: ConnectionParams): RegisterSessionResult {
    const { socket, userId, clientId } = params;
    if (userId === undefined || clientId === undefined) {
      this.logger.warn('Rejecting connection with missing userId/clientId');
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'missing userId/clientId');
      return { kind: 'rejected' };
    }
    if (this.sessions.has(clientId)) {
      this.logger.warn('Rejecting duplicate connection', clientId);
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'duplicate clientId');
      return { kind: 'duplicate' };
    }
    const session: Session = {
      userId,
      clientId,
      socket,
      sequenceNumber: 0,
      heartbeatAt: Date.now(),
      presenceToken: randomUUID(),
    };
    this.sessions.set(clientId, session);
    void this.presence.trackConnect(userId, clientId, session.presenceToken);
    socket.on('message', (data: unknown) => {
      this.handleMessage(clientId, data);
    });
    socket.on('error', (err: unknown) => {
      this.handleError(clientId, err);
    });
    socket.on('close', () => {
      this.sessions.delete(clientId);
      void this.presence.trackDisconnect(clientId, session.presenceToken);
      this.logger.log('Client disconnected', clientId);
    });
    this.logger.log('Client connected', clientId);
    return { kind: 'registered' };
  }

  /**
   * Retrieves a session by `ClientId`.
   *
   * - direct `Map.get` passthrough for routing sends to the right socket.
   *
   * @param clientId Unique session key to look up.
   * @return The session, or undefined when no session exists.
   */
  getSession(clientId: ClientId): Session | undefined {
    return this.sessions.get(clientId);
  }

  /**
   * Returns the number of currently connected sessions.
   *
   * - reads `sessions.size` without side effects.
   *
   * @return Count of active sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Serializes a payload to JSON once for the send path.
   *
   * - returns the JSON string when `message` serializes cleanly
   * - returns undefined when `stringify` throws or yields no string
   * - logs a per-client warning when `clientId` is given, else a broadcast warning.
   *
   * @param message Payload to serialize to JSON.
   * @param clientId Optional recipient for targeted log context.
   * @return The JSON string, or undefined when unserializable.
   */
  private serializeMessage(
    message: unknown,
    clientId?: ClientId,
  ): string | undefined {
    let payload: unknown;
    try {
      payload = JSON.stringify(message);
    } catch {
      payload = undefined;
    }
    if (typeof payload !== 'string') {
      if (clientId === undefined) {
        this.logger.warn('Dropping unserializable broadcast message');
      } else {
        this.logger.warn('Dropping unserializable message', clientId);
      }
      return undefined;
    }
    return payload;
  }

  /**
   * Sends an already-serialized payload to one client.
   *
   * - returns false when no session exists for `clientId`
   * - returns false when the socket is not currently open
   * - otherwise sends via `session.socket.send(...)` and returns true.
   *
   * @param clientId Unique session key of the recipient.
   * @param payload JSON string to send without re-serializing.
   * @return True when the message was sent.
   */
  private sendSerialized(clientId: ClientId, payload: string): boolean {
    const session = this.sessions.get(clientId);
    if (session === undefined) {
      return false;
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      session.socket.send(payload);
      return true;
    } catch {
      this.logger.warn('Failed to send message', clientId);
      return false;
    }
  }

  /**
   * Sends a JSON message to one client.
   *
   * - returns false when no session exists for `clientId`
   * - returns false when the socket is not currently open
   * - returns false when the payload cannot be serialized
   * - otherwise sends via `session.socket.send(...)` and returns true.
   *
   * @param clientId Unique session key of the recipient.
   * @param message Payload to serialize to JSON and send.
   * @return True when the message was sent.
   */
  sendToClient(clientId: ClientId, message: unknown): boolean {
    const payload = this.serializeMessage(message, clientId);
    if (payload === undefined) {
      return false;
    }
    return this.sendSerialized(clientId, payload);
  }

  /**
   * Sends a JSON message to many clients, best-effort.
   *
   * - serializes `message` once, then fans out the shared payload
   * - never throws, missing/closed/unserializable entries are skipped
   * - returns counts plus the serialized size so callers can observe
   *   without per-id receipts or re-serializing.
   *
   * @param clientIds Recipient session keys to fan out to.
   * @param message Payload to serialize to JSON once and send.
   * @return Sent/skipped counts plus the serialized payload size in bytes.
   */
  sendToClients(clientIds: ClientId[], message: unknown): FanOutResult {
    const payload = this.serializeMessage(message);
    if (payload === undefined) {
      return { sent: 0, skipped: clientIds.length, bytes: 0 };
    }
    let sent = 0;
    let skipped = 0;
    for (const clientId of clientIds) {
      if (this.sendSerialized(clientId, payload)) {
        sent += 1;
      } else {
        skipped += 1;
      }
    }
    return { sent, skipped, bytes: Buffer.byteLength(payload, 'utf8') };
  }

  /**
   * Observes an inbound message from a registered client.
   *
   * - lifecycle hook kept minimal by design, receipt is logged at debug level
   * - payload preview is truncated so one frame cannot flood the logs.
   *
   * @param clientId Owner of the socket that sent the message.
   * @param data Raw message payload from the socket.
   * @return Nothing, the payload is only logged.
   */
  private handleMessage(clientId: ClientId, data: unknown): void {
    const raw = String(data);
    const preview =
      raw.length > MAX_LOGGED_PAYLOAD_CHARS
        ? `${raw.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}… (truncated ${raw.length} chars)`
        : raw;
    this.logger.debug(`Message received: ${preview}`, clientId);
  }

  /**
   * Observes a socket error for a registered client.
   *
   * - lifecycle hook kept minimal by design, the error is logged
   * - the session stays until the socket `close` listener removes it.
   *
   * @param clientId Owner of the socket that errored.
   * @param err Raw error value from the socket.
   * @return Nothing, the error is only logged.
   */
  private handleError(clientId: ClientId, err: unknown): void {
    const detail = err instanceof Error ? err.message : 'unknown error';
    this.logger.error(`Socket error: ${detail}`, undefined, clientId);
  }
}
