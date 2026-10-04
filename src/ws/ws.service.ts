/**
 * In-memory WebSocket session registry with tracker fan-out.
 *
 * - Owns the `sessions` map keyed by branded `ClientId`, the single source
 *   of truth for local connections; per-user totals derive from it on demand
 * - Handles duplicate policy, lifecycle cleanup, and single-client sends
 * - Fans registered connects and socket closes out to `SESSION_TRACKERS`
 *   (presence, per-user topics); trackers are best-effort and never block.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  SESSION_TRACKERS,
  type ClientId,
  type ConnectionParams,
  type Session,
  type SessionLifecycleEvent,
  type SessionTracker,
  type UserId,
} from './session.interface';

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
 * Registry mapping `ClientId` to its live WebSocket session.
 *
 * - Trusts branded ids, they were validated once at the boundary
 * - Duplicate policy: reject the NEW connection, keep the existing session
 * - Each registration closes over its session, so the socket removes its own
 *   entry on `close` with no reverse lookup structure
 * - Tracker fan-out happens only on `registered`; `duplicate`/`rejected` do
 *   zero side-effect I/O so refused connections never touch presence or topics
 * - Each session mints a `presenceToken` fanned out as the event token, so a
 *   slow disconnect landing after a fast reconnect on the same `clientId`
 *   cannot remove the fresh presence row.
 */
@Injectable()
export class WsService {
  private readonly logger = new Logger(WsService.name);
  private readonly sessions = new Map<ClientId, Session>();

  /**
   * Creates the registry with its lifecycle observers.
   *
   * @param trackers Best-effort observers notified on connect/disconnect.
   */
  constructor(
    @Inject(SESSION_TRACKERS)
    private readonly trackers: SessionTracker[],
  ) {}

  /**
   * Registers a new connection as a session.
   *
   * - closes with 1008 when `userId`/`clientId` are undefined
   * - closes the NEW socket with 1008 when `clientId` already exists, old kept
   * - otherwise stores the socket with a fresh `presenceToken` and fans the
   *   connect out to every tracker; tracker failures never block the socket
   *   because trackers swallow them internally
   * - attaches `message`/`error` listeners for lifecycle coverage, plus a
   *   `close` listener that removes the session before fanning out the
   *   disconnect, so disconnected clients never linger while stale closes
   *   still carry the right token and remaining user total.
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
      presenceToken: randomUUID(),
    };
    this.sessions.set(clientId, session);
    this.notifyConnect(session);
    socket.on('message', (data: unknown) => {
      this.handleMessage(clientId, data);
    });
    socket.on('error', (err: unknown) => {
      this.handleError(clientId, err);
    });
    socket.on('close', () => {
      this.sessions.delete(clientId);
      this.notifyDisconnect(session);
      this.logger.log('Client disconnected', clientId);
    });
    this.logger.log('Client connected', clientId);
    return { kind: 'registered' };
  }

  /**
   * Fans a connect out to every tracker with the post-connect user total.
   *
   * - the session is already stored, so the count includes the new session.
   *
   * @param session Newly registered session.
   */
  private notifyConnect(session: Session): void {
    const event: SessionLifecycleEvent = {
      userId: session.userId,
      clientId: session.clientId,
      token: session.presenceToken,
      userSessionCount: this.countUserSessions(session.userId),
    };
    for (const tracker of this.trackers) {
      tracker.handleConnect(event);
    }
  }

  /**
   * Fans a disconnect out to every tracker with the remaining user total.
   *
   * - the session is already removed, so the count excludes the closed one.
   *
   * @param session Session whose socket just closed.
   */
  private notifyDisconnect(session: Session): void {
    const event: SessionLifecycleEvent = {
      userId: session.userId,
      clientId: session.clientId,
      token: session.presenceToken,
      userSessionCount: this.countUserSessions(session.userId),
    };
    for (const tracker of this.trackers) {
      tracker.handleDisconnect(event);
    }
  }

  /**
   * Counts live sessions for one user from the registry itself.
   *
   * - derives the total by scanning `sessions`, so no second map can drift
   * - linear in the session count, trivial next to socket I/O.
   *
   * @param userId Owner whose sessions to count.
   * @return Live local sessions for the user.
   */
  private countUserSessions(userId: UserId): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        count += 1;
      }
    }
    return count;
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
   * Sends a JSON message to one client.
   *
   * - returns false when the payload cannot be serialized
   * - returns false when no session exists for `clientId`
   * - returns false when the socket is not currently open
   * - otherwise sends via `session.socket.send(...)` and returns true.
   *
   * @param clientId Unique session key of the recipient.
   * @param message Payload to serialize to JSON and send.
   * @return True when the message was sent.
   */
  sendToClient(clientId: ClientId, message: unknown): boolean {
    let payload: string;
    try {
      const stringified: unknown = JSON.stringify(message);
      if (typeof stringified !== 'string') {
        this.logger.warn('Dropping unserializable message', clientId);
        return false;
      }
      payload = stringified;
    } catch {
      this.logger.warn('Dropping unserializable message', clientId);
      return false;
    }
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
