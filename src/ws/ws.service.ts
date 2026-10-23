/**
 * Manages WebSocket sessions, delivery, and lifecycle tracking.
 *
 * - OWNS the session lifecycle: registration, token expiry, close cleanup
 * - expiry and close share one identity-checked release, so trackers see each
 *   disconnect exactly once
 * - terminates the socket when its JWT expires
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { PublisherClient } from '../user-topics/publisher-client';
import {
  buildUserTopicEnvelope,
  channelFor,
} from '../user-topics/user-topic.message';
import {
  SESSION_TRACKERS,
  SEND_MESSAGE_ERROR_OP,
  canSendTo,
  parseInboundFrame,
  type ClientId,
  type ConnectionParams,
  type Session,
  type SessionLifecycleEvent,
  type SessionTracker,
  type UserId,
} from './session.interface';
import {
  MAX_TIMER_DELAY_MS,
  WS_CLOSE_MESSAGE_TOO_BIG,
  isWsPayloadTooBigError,
} from './ws.constants';

/** Close code for rejected connections. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** Maximum logged payload length. */
const MAX_LOGGED_PAYLOAD_CHARS = 500;

/**
 * Result of a session registration attempt.
 */
export type RegisterSessionResult =
  { kind: 'registered' } | { kind: 'duplicate' } | { kind: 'rejected' };

/**
 * Stores active sessions and notifies lifecycle trackers.
 */
@Injectable()
export class WsService implements OnModuleDestroy {
  private readonly logger = new Logger(WsService.name);
  private readonly sessions = new Map<ClientId, Session>();
  private readonly userClients = new Map<UserId, Set<ClientId>>();

  /**
   * Creates the registry with its trackers and publisher.
   *
   * @param trackers Session lifecycle observers.
   * @param publisher Redis connection for broadcasts.
   */
  constructor(
    @Inject(SESSION_TRACKERS)
    private readonly trackers: SessionTracker[],
    @Inject(REDIS_CLIENT)
    private readonly publisher: PublisherClient,
  ) {}

  /**
   * Validates, stores, and observes a new connection.
   *
   * - the verified token expiry arms a timer that terminates the socket later
   * - expiry and `close` both call the identity-checked release, so registry
   *   removal and the disconnect fan-out happen exactly once
   *
   * @param params Socket, parsed connection IDs, and token expiry.
   * @return Registration result.
   */
  handleConnection(params: ConnectionParams): RegisterSessionResult {
    const { socket, userId, clientId, expiresAt } = params;
    if (userId === undefined || clientId === undefined) {
      this.logger.warn('Rejecting connection with missing userId/clientId');
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'missing userId/clientId');
      return { kind: 'rejected' };
    }
    if (this.sessions.has(clientId)) {
      // TODO: enforce cross-replica uniqueness with a conditional DynamoDB claim.
      this.logger.warn('Rejecting duplicate connection', clientId);
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'duplicate clientId');
      return { kind: 'duplicate' };
    }
    const session: Session = {
      userId,
      clientId,
      socket,
      presenceToken: randomUUID(),
      expiresAt,
      expiryTimer: undefined,
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
      this.release(session);
      this.logger.log(`${userId} #${clientId} disconnected`);
    });
    this.logger.log(`${userId} #${clientId} connected`);
    this.scheduleExpiry(session);
    return { kind: 'registered' };
  }

  /**
   * Notifies all trackers without blocking session handling.
   *
   * @param session Affected session.
   * @param phase Connect or disconnect.
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
   * Invokes one lifecycle tracker.
   *
   * @param tracker Tracker to notify.
   * @param event Lifecycle data.
   * @param phase Connect or disconnect.
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
   * Adds a client to its user's membership index.
   *
   * @param userId Session owner.
   * @param clientId Client key.
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
   * Removes a client from its user's membership index.
   *
   * @param userId Session owner.
   * @param clientId Client key.
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
   * Counts a user's local sessions.
   *
   * @param userId User to count.
   * @return Number of local sessions.
   */
  private countUserSessions(userId: UserId): number {
    return this.userClients.get(userId)?.size ?? 0;
  }

  /**
   * Arms the timer that terminates the socket when its token expires.
   *
   * - waits at most `MAX_TIMER_DELAY_MS` per call because longer delays fire
   *   immediately; the timer re-arms against the remaining time
   * - an already stale expiry closes on the spot.
   *
   * @param session Session to expire.
   * @return Nothing.
   */
  private scheduleExpiry(session: Session): void {
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      this.handleExpiry(session);
      return;
    }
    session.expiryTimer = setTimeout(
      () => this.handleExpiryTimer(session),
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  }

  /**
   * Expires the session, or re-arms when the capped wait ended early.
   *
   * @param session Session the timer belongs to.
   * @return Nothing.
   */
  private handleExpiryTimer(session: Session): void {
    if (session.expiresAt - Date.now() > 0) {
      this.scheduleExpiry(session);
      return;
    }
    this.handleExpiry(session);
  }

  /**
   * Releases an expired session and terminates its socket.
   *
   * - removal happens before the fan-out, so trackers see the real remaining
   *   session count even when several sessions expire together
   * - terminating skips the close handshake, so an expired client cannot keep
   *   sending frames while the socket closes
   *
   * @param session Expired session.
   * @return Nothing.
   */
  private handleExpiry(session: Session): void {
    if (!this.release(session)) {
      return;
    }
    this.logger.log(`${session.userId} #${session.clientId} token expired`);
    session.socket.terminate();
  }

  /**
   * Removes a session from the registry and fans its disconnect out once.
   *
   * - the registry is the source of truth: a close arriving after expiry, or
   *   for a replaced `clientId`, finds no matching entry and does nothing
   * - counts the user's sessions after removal so trackers always see the
   *   remaining total
   *
   * @param session Session leaving the registry.
   * @return Whether this call performed the release.
   */
  private release(session: Session): boolean {
    if (this.sessions.get(session.clientId) !== session) {
      return false;
    }
    this.clearExpiryTimer(session);
    this.sessions.delete(session.clientId);
    this.untrackMembership(session.userId, session.clientId);
    this.fanOut(session, 'disconnect');
    return true;
  }

  /**
   * Cancels a pending expiry timer, if any.
   *
   * @param session Session whose timer to clear.
   * @return Nothing.
   */
  private clearExpiryTimer(session: Session): void {
    if (session.expiryTimer === undefined) {
      return;
    }
    clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
  }

  /**
   * Clears every pending expiry timer on shutdown.
   *
   * @return Nothing.
   */
  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      this.clearExpiryTimer(session);
    }
  }

  /**
   * Looks up a session by client ID.
   *
   * @param clientId Session key.
   * @return The session, if present.
   */
  getSession(clientId: ClientId): Session | undefined {
    return this.sessions.get(clientId);
  }

  /**
   * Returns the active session count.
   *
   * @return Number of sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Sends a JSON message to a connected client.
   *
   * @param clientId Recipient session key.
   * @param message Payload to send.
   * @return Whether the message was sent.
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
   * Publishes a broadcast to a user's sessions across replicas.
   *
   * @param userId Recipient user.
   * @param message Payload to broadcast.
   * @param excludeClientId Optional origin client to exclude.
   * @return Resolves when publishing completes.
   */
  async sendToUser(
    userId: UserId,
    message: unknown,
    excludeClientId?: ClientId,
  ): Promise<void> {
    const channel = channelFor(userId);
    let envelope: string;
    try {
      envelope = buildUserTopicEnvelope(message, excludeClientId);
    } catch {
      this.logger.warn('Dropping unserializable broadcast', channel);
      throw new Error(`Broadcast payload for ${channel} is not serializable`);
    }
    try {
      const receivers = await this.publisher.publish(channel, envelope);
      this.logger.debug(
        `Broadcast to ${channel}: ${Buffer.byteLength(envelope, 'utf8')} bytes, ${receivers} subscribers`,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`Failed to broadcast to ${channel}: ${detail}`);
      throw err instanceof Error ? err : new Error(detail);
    }
  }

  /**
   * Delivers a message to a user's local sessions.
   *
   * @param userId Recipient user.
   * @param message Payload to send.
   * @param excludeClientId Optional origin client to exclude.
   * @return Number of sessions reached.
   */
  sendToLocalUser(
    userId: UserId,
    message: unknown,
    excludeClientId?: ClientId,
  ): number {
    const members = this.userClients.get(userId);
    if (members === undefined) {
      return 0;
    }
    let delivered = 0;
    for (const clientId of members) {
      if (excludeClientId !== undefined && clientId === excludeClientId) {
        continue;
      }
      if (this.sendToClient(clientId, message)) {
        delivered += 1;
      }
    }
    return delivered;
  }

  /**
   * Parses an inbound message and routes valid sends.
   *
   * @param userId Sending user.
   * @param clientId Sending client.
   * @param data Raw socket payload.
   * @return Nothing; delivery failures are reported with a NACK.
   */
  private handleMessage(
    userId: UserId,
    clientId: ClientId,
    data: unknown,
  ): void {
    const raw = typeof data === 'string' ? data : String(data);
    const preview =
      raw.length > MAX_LOGGED_PAYLOAD_CHARS
        ? `${raw.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}… (truncated ${raw.length} chars)`
        : raw;
    this.logger.debug(
      `Message received from ${userId} #${clientId}: ${preview}`,
    );
    const frame = parseInboundFrame(data);
    if (frame.kind === 'ignore') {
      this.logger.debug(
        `Ignoring message from ${userId} #${clientId}: ${frame.reason}`,
      );
      return;
    }
    if (frame.kind === 'invalid') {
      this.logger.warn(
        `Dropping sendMessage with invalid target from ${userId} #${clientId}: ${frame.reason}`,
      );
      this.sendNack(clientId, frame.reason);
      return;
    }
    if (!canSendTo(userId, frame.target)) {
      this.logger.warn(
        `Dropping sendMessage not allowed from ${userId} #${clientId}`,
      );
      this.sendNack(clientId, 'not allowed');
      return;
    }
    void this.sendToUser(frame.target, frame.message, clientId).catch(
      (err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Failed to deliver message from ${userId} #${clientId}: ${detail}`,
        );
        this.sendNack(clientId, 'delivery failed');
      },
    );
  }

  /**
   * Sends a rejection frame to the origin client.
   *
   * @param clientId Client to notify.
   * @param reason Rejection reason.
   * @return Nothing.
   */
  private sendNack(clientId: ClientId, reason: string): void {
    this.sendToClient(clientId, { op: SEND_MESSAGE_ERROR_OP, reason });
  }

  /**
   * Logs socket errors, distinguishing oversized frames.
   *
   * @param userId Affected user.
   * @param clientId Affected client.
   * @param err Socket error.
   * @return Nothing.
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
