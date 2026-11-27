/**
 * Unit suite for WsService cluster claim lifecycle.
 *
 * - release: close and token expiry release the claim with its token
 * - renewal: a live session renews on an interval and stops after release
 * - loss: a lost claim terminates the socket so only one replica keeps the ID
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_RENEW_INTERVAL_MS } from '../cluster/cluster.constants';
import {
  createWsServiceHarness,
  type WsServiceHarness,
} from '../../test/ws-service-test.helper';
import {
  createSocketFake,
  fireClose,
  futureExpiryMs,
  requireClientId,
  requireUserId,
} from '../../test/ws-test.helper';

describe('WsService cluster claims', () => {
  let harness: WsServiceHarness;

  beforeEach(async () => {
    vi.useFakeTimers();
    harness = await createWsServiceHarness();
  });

  afterEach(async () => {
    await harness.module.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('releases the claim when a socket closes', () => {
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });

    fireClose(fake);

    expect(harness.cluster.releaseClient).toHaveBeenCalledWith(
      requireClientId('client-456'),
      'claim-1',
    );
  });

  it('skips claim release when the gateway did not claim the client', () => {
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: futureExpiryMs(),
    });

    fireClose(fake);

    expect(harness.cluster.releaseClient).not.toHaveBeenCalled();
  });

  it('releases the claim when the token expires', () => {
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: Date.now() + 1_000,
      claimToken: 'claim-1',
    });

    vi.advanceTimersByTime(1_000);

    expect(fake.mocks.terminate).toHaveBeenCalledTimes(1);
    expect(harness.cluster.releaseClient).toHaveBeenCalledWith(
      requireClientId('client-456'),
      'claim-1',
    );
  });

  it('renews the claim while the session lives and stops after close', () => {
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });

    vi.advanceTimersByTime(CLAIM_RENEW_INTERVAL_MS);
    expect(harness.cluster.renewClient).toHaveBeenCalledWith(
      requireClientId('client-456'),
      'claim-1',
    );

    fireClose(fake);
    vi.advanceTimersByTime(CLAIM_RENEW_INTERVAL_MS);
    expect(harness.cluster.renewClient).toHaveBeenCalledTimes(1);
  });

  it('terminates the session when another replica takes the claim', async () => {
    harness.cluster.renewClient.mockResolvedValueOnce(false);
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });

    vi.advanceTimersByTime(CLAIM_RENEW_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.mocks.terminate).toHaveBeenCalledTimes(1);
    expect(harness.cluster.releaseClient).toHaveBeenCalledWith(
      requireClientId('client-456'),
      'claim-1',
    );
    expect(harness.service.getSessionCount()).toBe(0);
  });

  it('keeps the session and warns when a renewal fails', async () => {
    harness.cluster.renewClient.mockRejectedValueOnce(new Error('redis down'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const fake = createSocketFake();
    harness.service.handleConnection({
      socket: fake.socket,
      userId: requireUserId('user-123'),
      clientId: requireClientId('client-456'),
      expiresAt: futureExpiryMs(),
      claimToken: 'claim-1',
    });

    vi.advanceTimersByTime(CLAIM_RENEW_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to renew claim for client-456'),
    );
    expect(fake.mocks.terminate).not.toHaveBeenCalled();
    expect(harness.service.getSessionCount()).toBe(1);
  });
});
