/**
 * Manages WebSocket sessions and delivery.
 *
 * - local maps own live sockets; Redis claims own client IDs across replicas
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { CLAIM_RENEW_INTERVAL_MS } from '../cluster/cluster.constants';
import { ClusterService } from '../cluster/cluster.service';
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
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_MESSAGE_TOO_BIG,
  isWsPayloadTooBigError,
} from './ws.constants';

/** Rejected connection close code. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** Maximum payload length in logs. */
const MAX_LOGGED_PAYLOAD_CHARS = 500;

/** Session registration outcome, carrying the connect fan-out on success. */
export type RegisterSessionResult =
  | { kind: 'registered'; pending: Promise<void> }
  | { kind: 'duplicate' }
  | { kind: 'rejected' };

/**
 * Stores sessions and notifies trackers.
 */
@Injectable()
export class WsService implements OnModuleDestroy {
  private readonly logger = new Logger(WsService.name);
  private readonly sessions = new Map<ClientId, Session>();
  private readonly userClients = new Map<UserId, Set<ClientId>>();
  private readonly claimReleases = new Set<Promise<void>>();
  private draining = false;

  /**
   * Creates the session registry.
   *
   * @param trackers Session observers.
   * @param publisher Redis publisher.
   * @param cluster Cluster claims.
   */
  constructor(
    @Inject(SESSION_TRACKERS)
    private readonly trackers: SessionTracker[],
    @Inject(REDIS_CLIENT)
    private readonly publisher: PublisherClient,
    private readonly cluster: ClusterService,
  ) {}

  /**
   * Registers a connection and schedules token expiry.
   *
   * @param params Connection details and token expiry.
   * @return Registration outcome.
   */
  handleConnection(params: ConnectionParams): RegisterSessionResult {
    const { socket, userId, clientId } = params;
    if (this.draining) {
      this.logger.warn('Rejecting connection while draining');
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'server shutting down');
      return { kind: 'rejected' };
    }
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
    const presenceToken = randomUUID();
    this.trackMembership(userId, clientId);
    const pending = this.fanOut({ userId, clientId, presenceToken }, 'connect');
    const session: Session = {
      userId,
      clientId,
      socket,
      presenceToken,
      expiresAt: params.expiresAt,
      expiryTimer: undefined,
      claimToken: params.claimToken,
      claimTimer: undefined,
      trackerPending: pending,
    };
    this.sessions.set(clientId, session);
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
    this.startClaimRenewal(session);
    return { kind: 'registered', pending };
  }

  /**
   * Notifies trackers without blocking session handling.
   *
   * @param session Affected session.
   * @param phase Lifecycle phase.
   * @return Resolves when every tracker has settled.
   */
  private fanOut(
    session: Pick<Session, 'userId' | 'clientId' | 'presenceToken'>,
    phase: 'connect' | 'disconnect',
  ): Promise<void> {
    const event: SessionLifecycleEvent = {
      userId: session.userId,
      clientId: session.clientId,
      token: session.presenceToken,
      userSessionCount: this.countUserSessions(session.userId),
    };
    const pending = this.trackers.map((tracker) =>
      this.notifyTracker(tracker, event, phase),
    );
    return Promise.allSettled(pending).then((results) => {
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
   * Notifies one tracker.
   *
   * @param tracker Tracker to notify.
   * @param event Session event.
   * @param phase Lifecycle phase.
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
   * Adds a client to the user's index.
   *
   * @param userId Session owner.
   * @param clientId Client ID.
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
   * Removes a client from the user's index.
   *
   * @param userId Session owner.
   * @param clientId Client ID.
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
   * Counts the user's local sessions.
   *
   * @param userId User to count.
   * @return Local session count.
   */
  private countUserSessions(userId: UserId): number {
    return this.userClients.get(userId)?.size ?? 0;
  }

  /**
   * Schedules socket termination at token expiry.
   *
   * @param session Session to schedule.
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
   * Re-arms early timers or expires the session.
   *
   * @param session Timed session.
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
   * Removes a session and notifies trackers once.
   *
   * @param session Session to remove.
   * @return Whether the session was removed.
   */
  private release(session: Session): boolean {
    if (this.sessions.get(session.clientId) !== session) {
      return false;
    }
    this.clearExpiryTimer(session);
    this.clearClaimTimer(session);
    this.sessions.delete(session.clientId);
    this.untrackMembership(session.userId, session.clientId);
    session.trackerPending = this.fanOut(session, 'disconnect');
    this.releaseClaim(session);
    return true;
  }

  /**
   * Releases the cluster claim without blocking socket teardown.
   *
   * - `ClusterService` absorbs release failures, so no second handler is needed
   *
   * @param session Session whose claim should be released.
   * @return Nothing.
   */
  private releaseClaim(session: Session): void {
    const { claimToken } = session;
    if (claimToken === undefined) {
      return;
    }
    const release = this.cluster.releaseClient(session.clientId, claimToken);
    this.claimReleases.add(release);
    void release.then(() => {
      this.claimReleases.delete(release);
    });
  }

  /**
   * Starts claim renewal for a session that holds a claim.
   *
   * @param session Session whose claim should stay alive.
   * @return Nothing.
   */
  private startClaimRenewal(session: Session): void {
    if (session.claimToken === undefined) {
      return;
    }
    session.claimTimer = setInterval(() => {
      void this.renewClaim(session);
    }, CLAIM_RENEW_INTERVAL_MS);
  }

  /**
   * Renews a claim, ending the session if another replica now owns it.
   *
   * - Redis errors only warn; the next interval retries while the TTL lasts
   * - a definite loss terminates the socket so only one replica keeps the ID
   *
   * @param session Session whose claim should be renewed.
   * @return Nothing.
   */
  private async renewClaim(session: Session): Promise<void> {
    if (session.claimToken === undefined) {
      return;
    }
    let renewed: boolean;
    try {
      renewed = await this.cluster.renewClient(
        session.clientId,
        session.claimToken,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Failed to renew claim for ${session.clientId}: ${detail}`,
      );
      return;
    }
    if (renewed) {
      return;
    }
    this.logger.warn(`Lost claim for ${session.clientId}; terminating session`);
    if (this.release(session)) {
      session.socket.terminate();
    }
  }

  /**
   * Cancels the session's claim renewal timer.
   *
   * @param session Session to clear.
   * @return Nothing.
   */
  private clearClaimTimer(session: Session): void {
    if (session.claimTimer === undefined) {
      return;
    }
    clearInterval(session.claimTimer);
    session.claimTimer = undefined;
  }

  /**
   * Cancels the session's expiry timer.
   *
   * @param session Session to clear.
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
   * Drains sessions on shutdown and waits for tracker fan-out.
   *
   * @return Resolves when sessions are released and trackers have settled.
   */
  async onModuleDestroy(): Promise<void> {
    this.draining = true;
    const pending: Promise<void>[] = [];
    for (const session of [...this.sessions.values()]) {
      if (!this.release(session)) {
        continue;
      }
      pending.push(session.trackerPending);
      session.socket.close(WS_CLOSE_GOING_AWAY, 'server shutting down');
    }
    await Promise.allSettled([...pending, ...this.claimReleases]);
  }

  /**
   * Looks up a session by client ID.
   *
   * @param clientId Session ID.
   * @return The session, if found.
   */
  getSession(clientId: ClientId): Session | undefined {
    return this.sessions.get(clientId);
  }

  /**
   * Returns the active local session count.
   *
   * @return Local session count.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Sends JSON to a connected local client.
   *
   * @param clientId Recipient session ID.
   * @param message Payload to send.
   * @return Whether sending succeeded.
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
   * Publishes a message to the user's sessions across replicas.
   *
   * @param userId Recipient.
   * @param message Payload to broadcast.
   * @param excludeClientId Optional client to exclude.
   * @return Resolves when published.
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
   * Delivers a message to the user's local sessions.
   *
   * @param userId Recipient.
   * @param message Payload to send.
   * @param excludeClientId Optional client to exclude.
   * @return Sessions reached.
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
   * Parses and routes an inbound message.
   *
   * @param userId Sender.
   * @param clientId Sender's client.
   * @param data Socket payload.
   * @return Nothing; failures receive a NACK.
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
   * Sends a rejection to the client.
   *
   * @param clientId Client to notify.
   * @param reason Rejection reason.
   * @return Nothing.
   */
  private sendNack(clientId: ClientId, reason: string): void {
    this.sendToClient(clientId, { op: SEND_MESSAGE_ERROR_OP, reason });
  }

  /**
   * Logs socket errors, including oversized frames.
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
