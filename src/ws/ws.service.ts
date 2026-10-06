/**
 * In-memory WebSocket session registry with tracker fan-out.
 *
 * - Owns the `sessions` map keyed by branded `ClientId`, the single source
 *   of truth for local connections, plus a `userClients` membership index
 *   for O(1) per-user totals; both update together on register/close
 * - Handles duplicate policy, lifecycle cleanup, and single-client sends
 * - Fans registered connects and socket closes out to `SESSION_TRACKERS`
 *   (presence, per-user topics) via one `fanOut` path that isolates every
 *   tracker with `Promise.allSettled`, so tracker N+1 cannot stall or break
 *   registration, teardown, or sibling trackers
 * - Each session mints a `presenceToken` fanned out as the event token, so a
 *   slow disconnect landing after a fast reconnect on the same `clientId`
 *   cannot remove the fresh presence row.
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
import {
  WS_CLOSE_MESSAGE_TOO_BIG,
  isWsPayloadTooBigError,
} from './ws.constants';

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
 *   zero side-effect I/O so refused connections never touch presence or topics.
 */
@Injectable()
export class WsService {
  private readonly logger = new Logger(WsService.name);
  private readonly sessions = new Map<ClientId, Session>();
  private readonly userClients = new Map<UserId, Set<ClientId>>();

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
   *   connect out; tracker failures never block the socket because fan-out
   *   settles every tracker in the background
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
    this.trackMembership(userId, clientId);
    this.fanOut(session, 'connect');
    socket.on('message', (data: unknown) => {
      this.handleMessage(userId, clientId, data);
    });
    socket.on('error', (err: unknown) => {
      this.handleError(userId, clientId, err);
    });
    socket.on('close', () => {
      this.sessions.delete(clientId);
      this.untrackMembership(userId, clientId);
      this.fanOut(session, 'disconnect');
      this.logger.log(`${userId} #${clientId} disconnected`);
    });
    this.logger.log(`${userId} #${clientId} connected`);
    return { kind: 'registered' };
  }

  /**
   * Fans one lifecycle event out to every tracker in the background.
   *
   * - single owner of tracker error isolation: each tracker runs behind
   *   `Promise.allSettled` via an async boundary, so sync throws become
   *   rejections and one failing tracker never blocks siblings
   * - rejections log at warn with the tracker index and phase, then resolve
   * - connect counts include the new session, disconnect counts exclude the
   *   closed one, because membership updates before this call in both paths.
   *
   * @param session Session the event belongs to.
   * @param phase Whether this is a connect or a disconnect fan-out.
   */
  private fanOut(session: Session, phase: 'connect' | 'disconnect'): void {
    const event: SessionLifecycleEvent = {
      userId: session.userId,
      clientId: session.clientId,
      token: session.presenceToken,
      userSessionCount: this.countUserSessions(session.userId),
    };
    const pending = this.trackers.map((tracker) =>
      this.notifyTracker(tracker, event, phase),
    );
    void Promise.allSettled(pending).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const detail =
            result.reason instanceof Error
              ? result.reason.message
              : 'unknown error';
          this.logger.warn(
            `Session tracker ${index} ${phase} failed: ${detail}`,
          );
        }
      });
    });
  }

  /**
   * Invokes one tracker behind an async boundary.
   *
   * - the `async` boundary converts sync throws into rejections, so the
   *   `allSettled` in `fanOut` sees every failure mode uniformly.
   *
   * @param tracker Observer to notify.
   * @param event Session identity plus the current user total.
   * @param phase Whether this is a connect or a disconnect notification.
   */
  private async notifyTracker(
    tracker: SessionTracker,
    event: SessionLifecycleEvent,
    phase: 'connect' | 'disconnect',
  ): Promise<void> {
    if (phase === 'connect') {
      await tracker.handleConnect(event);
    } else {
      await tracker.handleDisconnect(event);
    }
  }

  /**
   * Records one membership of a client in its user's index.
   *
   * @param userId Owner of the session.
   * @param clientId Session key to index.
   */
  private trackMembership(userId: UserId, clientId: ClientId): void {
    let members = this.userClients.get(userId);
    if (members === undefined) {
      members = new Set<ClientId>();
      this.userClients.set(userId, members);
    }
    members.add(clientId);
  }

  /**
   * Removes one membership, dropping the user's entry when it empties.
   *
   * @param userId Owner of the session.
   * @param clientId Session key to remove.
   */
  private untrackMembership(userId: UserId, clientId: ClientId): void {
    const members = this.userClients.get(userId);
    if (members === undefined) {
      return;
    }
    members.delete(clientId);
    if (members.size === 0) {
      this.userClients.delete(userId);
    }
  }

  /**
   * Counts live sessions for one user from the membership index.
   *
   * - O(1) read of the index maintained alongside `sessions`, so reconnect
   *   storms never degrade into quadratic scans.
   *
   * @param userId Owner whose sessions to count.
   * @return Live local sessions for the user.
   */
  private countUserSessions(userId: UserId): number {
    return this.userClients.get(userId)?.size ?? 0;
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
   * - returns false when no session exists for `clientId`
   * - returns false when the socket is not currently open
   * - returns false when the payload cannot be serialized
   * - otherwise sends via `session.socket.send(...)` and returns true
   * - cheap guards run before serialization so misses never pay it.
   *
   * @param clientId Unique session key of the recipient.
   * @param message Payload to serialize to JSON and send.
   * @return True when the message was sent.
   */
  sendToClient(clientId: ClientId, message: unknown): boolean {
    const session = this.sessions.get(clientId);
    if (session === undefined) {
      return false;
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
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
   * @param userId Owner of the session that sent the message.
   * @param clientId Owner of the socket that sent the message.
   * @param data Raw message payload from the socket.
   * @return Nothing, the payload is only logged.
   */
  private handleMessage(
    userId: UserId,
    clientId: ClientId,
    data: unknown,
  ): void {
    const raw = String(data);
    const preview =
      raw.length > MAX_LOGGED_PAYLOAD_CHARS
        ? `${raw.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}… (truncated ${raw.length} chars)`
        : raw;
    this.logger.debug(
      `Message received from ${userId} #${clientId}: ${preview}`,
    );
  }

  /**
   * Observes a socket error for a registered client.
   *
   * - oversize frames rejected by the transport `maxPayload` log at warn
   *   with identity and the close code, never with payload bytes
   * - other errors log at error level as before
   * - the session stays until the socket `close` listener removes it.
   *
   * @param userId Owner of the session that errored.
   * @param clientId Owner of the socket that errored.
   * @param err Raw error value from the socket.
   * @return Nothing, the error is only logged.
   */
  private handleError(userId: UserId, clientId: ClientId, err: unknown): void {
    if (isWsPayloadTooBigError(err)) {
      this.logger.warn(
        `Oversize frame rejected for ${userId} #${clientId} ` +
          `(code ${WS_CLOSE_MESSAGE_TOO_BIG})`,
      );
      return;
    }
    const detail = err instanceof Error ? err.message : 'unknown error';
    this.logger.error(`Socket error: ${detail}`, undefined, clientId);
  }
}
