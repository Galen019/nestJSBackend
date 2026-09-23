/**
 * Unit suite for PushService boundary parsing plus fan-out.
 *
 * - mocks WsService.sendToClients, asserts parsed ids and coerced payloads
 * - covers id parsing, blanks dropped, cap enforced, fire-and-forget empties
 * - covers JSON message parsing, truncation, and non-string passthrough
 * - covers stream slot handles up to the concurrency cap
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsService } from '../ws/ws.service';
import {
  MAX_CLIENT_IDS,
  MAX_CONCURRENT_STREAMS,
  MAX_MESSAGE_CHARS,
} from './push.constants';
import { PushService } from './push.service';

describe('PushService', () => {
  let service: PushService;
  let module: TestingModule | undefined;
  let sendToClients: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with a mocked WsService.
   *
   * - fresh mock per test so call counts never leak
   * - tracks the module so it can be closed after each test.
   *
   * @return The compiled push service.
   */
  async function compile(): Promise<PushService> {
    sendToClients = vi.fn(() => ({ sent: 0, skipped: 0 }));
    module = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: WsService, useValue: { sendToClients } },
      ],
    }).compile();
    return module.get<PushService>(PushService);
  }

  beforeEach(async () => {
    service = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('fans out camelCase ids with a JSON message parsed to an object', () => {
    service.publish({ clientIds: ['a', 'b'], message: '{"x":1}' });

    expect(sendToClients).toHaveBeenCalledTimes(1);
    expect(sendToClients).toHaveBeenCalledWith(['a', 'b'], { x: 1 });
  });

  it('forwards plain string messages untouched', () => {
    service.publish({ clientIds: ['a'], message: 'hello' });

    expect(sendToClients).toHaveBeenCalledWith(['a'], 'hello');
  });

  it('drops blank ids and does nothing when none remain', () => {
    service.publish({ clientIds: ['   ', ''], message: 'hi' });

    expect(sendToClients).not.toHaveBeenCalled();
  });

  it('does nothing for missing or non-object chunks', () => {
    service.publish(undefined);
    service.publish(null);
    service.publish('nope');
    service.publish({});

    expect(sendToClients).not.toHaveBeenCalled();
  });

  it('caps ids at MAX_CLIENT_IDS', () => {
    const ids = Array.from(
      { length: MAX_CLIENT_IDS + 5 },
      (_, i) => `c-${String(i)}`,
    );

    service.publish({ clientIds: ids, message: 'hi' });

    expect(sendToClients).toHaveBeenCalledTimes(1);
    const sentIds = sendToClients.mock.calls[0]?.[0] as string[];
    expect(sentIds).toHaveLength(MAX_CLIENT_IDS);
  });

  it('truncates oversized string messages', () => {
    service.publish({
      clientIds: ['a'],
      message: 'x'.repeat(MAX_MESSAGE_CHARS + 10),
    });

    const payload = sendToClients.mock.calls[0]?.[1] as string;
    expect(payload).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it('forwards non-string messages untouched', () => {
    const message = { type: 'PING' };

    service.publish({ clientIds: ['a'], message });

    expect(sendToClients).toHaveBeenCalledWith(['a'], message);
  });

  it('fans out an already-normalized chunk', () => {
    service.publishNormalized({ ids: ['a'], message: 'hello' });

    expect(sendToClients).toHaveBeenCalledWith(['a'], 'hello');
  });

  it('hands out release handles up to the concurrency cap', () => {
    const releases: Array<() => void> = [];
    for (let index = 0; index < MAX_CONCURRENT_STREAMS; index += 1) {
      const release = service.beginStream();
      expect(release).toBeDefined();
      if (release !== undefined) {
        releases.push(release);
      }
    }

    expect(service.beginStream()).toBeUndefined();
    releases.forEach((release) => release());
    const retry = service.beginStream();

    expect(retry).toBeDefined();
  });

  it('ignores double releases of one handle', () => {
    const release = service.beginStream();

    expect(release).toBeDefined();
    release?.();
    release?.();

    expect(service.beginStream()).toBeDefined();
  });
});
