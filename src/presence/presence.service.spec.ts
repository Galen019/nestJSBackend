/**
 * Unit suite for PresenceService with a mocked DynamoService client.
 *
 * - mocks `DynamoService.getClient()` with a `send` stub, no AWS calls
 * - connect: puts `User { userId }` then `Clients` with `expiresAt` and token
 * - disconnect: deletes `Clients { clientId }` conditional on the token
 * - stale disconnect: a failed token condition resolves without a warn log
 * - failure: Dynamo errors resolve (never reject) with a warn log.
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoService } from '../dynamo/dynamo.service';
import {
  CLIENT_PRESENCE_TTL_SECONDS,
  EXPIRING_ITEM_TTL_SECONDS,
} from '../dynamo/ttl';
import {
  parseClientId,
  parseUserId,
  type ClientId,
  type UserId,
} from '../ws/session.interface';
import { PresenceService } from './presence.service';

/**
 * Creates a fake DynamoDB client surface with a mocked `send`.
 *
 * @return Fake client plus its `send` mock.
 */
function createClientFake() {
  const send = vi
    .fn<(command: unknown) => Promise<unknown>>()
    .mockResolvedValue({});
  return { send, client: { send } };
}

/**
 * Parses a test `userId`, failing fast on bad literals.
 *
 * @param value Literal user id used by the test.
 * @return The branded user id.
 */
function requireUserId(value: string): UserId {
  const parsed = parseUserId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test userId: ${value}`);
  }
  return parsed;
}

/**
 * Parses a test `clientId`, failing fast on bad literals.
 *
 * @param value Literal client id used by the test.
 * @return The branded client id.
 */
function requireClientId(value: string): ClientId {
  const parsed = parseClientId(value);
  if (parsed === undefined) {
    throw new Error(`Invalid test clientId: ${value}`);
  }
  return parsed;
}

describe('PresenceService', () => {
  let service: PresenceService;
  let module: TestingModule | undefined;
  let send: ReturnType<typeof createClientFake>['send'];

  /**
   * Builds a testing module with a mocked DynamoService.
   *
   * @return The compiled presence service.
   */
  async function compile(): Promise<PresenceService> {
    const fake = createClientFake();
    send = fake.send;
    module = await Test.createTestingModule({
      providers: [
        PresenceService,
        {
          provide: DynamoService,
          useValue: { getClient: () => fake.client },
        },
      ],
    }).compile();
    return module.get<PresenceService>(PresenceService);
  }

  beforeEach(async () => {
    service = await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('puts User then Clients rows with a 1-day expiresAt on connect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await service.trackConnect(
        requireUserId('user-123'),
        requireClientId('client-456'),
        'presence-token-1',
      );
    } finally {
      vi.useRealTimers();
    }

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0];
    const second = send.mock.calls[1]?.[0];
    expect(first).toBeInstanceOf(PutItemCommand);
    expect(second).toBeInstanceOf(PutItemCommand);
    expect((first as PutItemCommand).input).toEqual({
      TableName: 'User',
      Item: { userId: { S: 'user-123' } },
    });
    expect((second as PutItemCommand).input).toEqual({
      TableName: 'Clients',
      Item: {
        clientId: { S: 'client-456' },
        userId: { S: 'user-123' },
        expiresAt: { N: String(nowSeconds + CLIENT_PRESENCE_TTL_SECONDS) },
        presenceToken: { S: 'presence-token-1' },
      },
    });
    expect(CLIENT_PRESENCE_TTL_SECONDS).not.toBe(EXPIRING_ITEM_TTL_SECONDS);
  });

  it('deletes the Clients row conditional on the presence token', async () => {
    await service.trackDisconnect(
      requireClientId('client-456'),
      'presence-token-1',
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteItemCommand);
    expect((command as DeleteItemCommand).input).toEqual({
      TableName: 'Clients',
      Key: { clientId: { S: 'client-456' } },
      ConditionExpression: 'presenceToken = :token',
      ExpressionAttributeValues: { ':token': { S: 'presence-token-1' } },
    });
  });

  it('deletes unconditionally without a token for legacy callers', async () => {
    await service.trackDisconnect(requireClientId('client-456'));

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteItemCommand);
    expect((command as DeleteItemCommand).input).toEqual({
      TableName: 'Clients',
      Key: { clientId: { S: 'client-456' } },
    });
  });

  it('resolves without a warn log when a stale disconnect loses its race', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('condition failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.trackDisconnect(requireClientId('client-456'), 'stale-token'),
    ).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves instead of rejecting when Dynamo fails on connect', async () => {
    send.mockRejectedValueOnce(new Error('dynamo down'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.trackConnect(
        requireUserId('user-123'),
        requireClientId('client-456'),
        'presence-token-1',
      ),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connect'));
  });

  it('resolves instead of rejecting when Dynamo fails on disconnect', async () => {
    send.mockRejectedValueOnce(new Error('dynamo down'));
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.trackDisconnect(requireClientId('client-456')),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disconnect'));
  });
});
