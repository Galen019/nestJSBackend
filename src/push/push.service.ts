/**
 * gRPC fan-out service.
 *
 * - Thin boundary parser plus delegation to the WS session registry
 * - Fire-and-forget: invalid ids are dropped, never thrown
 * - Hands out stream slots the controller releases on teardown.
 */

import { Injectable, Logger } from '@nestjs/common';
import { parseClientId, type ClientId } from '../ws/session.interface';
import { WsService } from '../ws/ws.service';
import {
  MAX_CLIENT_IDS,
  MAX_CONCURRENT_STREAMS,
  MAX_MESSAGE_CHARS,
} from './push.constants';
import { normalizeChunk, type NormalizedChunk } from './stream-budget';

/**
 * Raw gRPC payload shape after proto-loader.
 *
 * - `clientIds` is the camelCased form of wire `client_ids`
 * - the camelCase mapping relies on proto-loader's default `keepCase: false`
 * - fields stay optional because the loader omits empty values.
 */
export interface PublishRequestGrpc {
  clientIds?: string[];
  message?: string;
}

/**
 * Parses and fans out `PublishRequest` chunks to WebSocket sessions.
 *
 * - Owns all boundary validation so the controller stays thin
 * - Caps, parses, coerces, then delegates to `WsService.sendToClients`.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private activeStreams = 0;

  constructor(private readonly wsService: WsService) {}

  /**
   * Reserves a slot for one `Publish` stream.
   *
   * - returns undefined without mutating state when at MAX_CONCURRENT_STREAMS
   * - otherwise returns a release handle the caller runs exactly once.
   *
   * @return Release handle, or undefined when no slot is free.
   */
  beginStream(): (() => void) | undefined {
    if (this.activeStreams >= MAX_CONCURRENT_STREAMS) {
      return undefined;
    }
    this.activeStreams += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeStreams -= 1;
      }
    };
  }

  /**
   * Fans out one stream chunk to matching sockets, best-effort.
   *
   * - normalizes, then delegates to `publishNormalized`
   * - never throws, missing/closed sockets are skipped inside `WsService`.
   *
   * @param raw Raw chunk from the gRPC stream.
   * @return Nothing, delivery counts are logged at debug level.
   */
  publish(raw: unknown): void {
    this.publishNormalized(normalizeChunk(raw));
  }

  /**
   * Fans out one already-normalized chunk to matching sockets, best-effort.
   *
   * - caps ids at MAX_CLIENT_IDS, drops blanks/unparseable ids
   * - coerces `message`: JSON strings are parsed, other values forwarded as-is
   * - never throws, missing/closed sockets are skipped inside `WsService`.
   *
   * @param chunk Normalized ids plus opaque message from the quota path.
   * @return Nothing, delivery counts are logged at debug level.
   */
  publishNormalized(chunk: NormalizedChunk): void {
    const { ids, message } = chunk;
    const capped = ids.slice(0, MAX_CLIENT_IDS);
    if (ids.length > MAX_CLIENT_IDS) {
      this.logger.warn(
        `Dropping ${ids.length - MAX_CLIENT_IDS} clientIds over cap ${MAX_CLIENT_IDS}`,
      );
    }
    const parsed: ClientId[] = [];
    for (const id of capped) {
      const clientId = parseClientId(id);
      if (clientId !== undefined) {
        parsed.push(clientId);
      }
    }
    if (parsed.length === 0) {
      return;
    }
    const payload = this.coerceMessage(message);
    const { sent, skipped } = this.wsService.sendToClients(parsed, payload);
    this.logger.debug(
      `Fan-out to ${parsed.length} clients: sent ${sent}, skipped ${skipped}`,
    );
  }

  /**
   * Coerces the opaque message for the WS JSON send path.
   *
   * - JSON strings are parsed so clients receive objects, not double-encoded text
   * - oversized strings are truncated to MAX_MESSAGE_CHARS first
   * - non-string values are forwarded untouched for `sendToClient` to stringify.
   *
   * @param message Raw message value from the chunk.
   * @return Payload suitable for `WsService.sendToClients`.
   */
  private coerceMessage(message: unknown): unknown {
    if (typeof message !== 'string') {
      return message;
    }
    const capped =
      message.length > MAX_MESSAGE_CHARS
        ? message.slice(0, MAX_MESSAGE_CHARS)
        : message;
    const trimmed = capped.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return capped;
      }
    }
    return capped;
  }
}
