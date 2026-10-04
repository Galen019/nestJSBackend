/**
 * Test suite for DynamoService with a mocked DynamoDB client.
 *
 * - onModuleInit: connects without retry, retries then connects, exhausts
 * - bootstrap gate: skips non-local endpoints, creates on local, forces via flag
 * - bootstrap failure: fail-open boot with an error log, never rejects
 * - TTL: enables disabled TTL, corrects a wrong attribute, skips matching TTL
 * - ping: delegates to ListTables, propagates errors
 * - onModuleDestroy: destroys the client
 * - getClient: returns the injected client
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DYNAMO_CLIENT } from './dynamo.constants';
import { DynamoService } from './dynamo.service';
import { TABLE_DEFINITIONS } from './table-defs';

/**
 * Creates a fresh mocked DynamoDB client for DI.
 *
 * - stubs `send` to resolve and `destroy` to no-op by default.
 */
function createClientFake() {
  return {
    send: vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValue({ TableNames: [] }),
    destroy: vi.fn<() => unknown>().mockReturnValue(undefined),
  };
}

type ClientFake = ReturnType<typeof createClientFake>;

/**
 * Creates a ResourceNotFound-shaped SDK error.
 *
 * @return Error with the SDK exception name.
 */
function resourceNotFound(): Error {
  return Object.assign(new Error('missing'), {
    name: 'ResourceNotFoundException',
  });
}

describe('DynamoService', () => {
  let service: DynamoService;
  let client: ClientFake;
  const previousEnv = { ...process.env };

  /**
   * Builds a testing module with the mocked DYNAMO_CLIENT.
   *
   * - provides current `client` fake as DYNAMO_CLIENT value
   * - returns compiled TestingModule for service resolution.
   */
  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        DynamoService,
        {
          provide: DYNAMO_CLIENT,
          useValue: client as unknown as DynamoDBClient,
        },
      ],
    }).compile();
  }

  beforeEach(() => {
    client = createClientFake();
    process.env.DYNAMODB_ENDPOINT = 'https://dynamo.prod.example.com';
    delete process.env.DYNAMODB_BOOTSTRAP;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    vi.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('connects on startup without retry', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      expect(client.send).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('retries failed attempts then connects', async () => {
      vi.useFakeTimers();
      client.send
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ TableNames: [] });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      const init = service.onModuleInit();
      await vi.runAllTimersAsync();
      await init;

      expect(client.send).toHaveBeenCalledTimes(3);
      await module.close();
    });

    it('throws after exhausting retries', async () => {
      vi.useFakeTimers();
      client.send.mockRejectedValue(new Error('ECONNREFUSED'));
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      const init = service.onModuleInit();
      const assertion = expect(init).rejects.toThrow('ECONNREFUSED');
      await vi.runAllTimersAsync();
      await assertion;

      expect(client.send).toHaveBeenCalledTimes(10);
      await module.close();
    });

    it('skips bootstrap for non-local endpoints', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      expect(client.send).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('creates missing tables and enables TTL on local endpoints', async () => {
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
      const createdTables = new Set<string>();
      client.send.mockImplementation(async (command: unknown) => {
        if (command instanceof ListTablesCommand) {
          return { TableNames: [] };
        }
        if (command instanceof DescribeTableCommand) {
          const tableName = command.input.TableName ?? '';
          if (createdTables.has(tableName)) {
            return { Table: { TableName: tableName, TableStatus: 'ACTIVE' } };
          }
          throw resourceNotFound();
        }
        if (command instanceof CreateTableCommand) {
          createdTables.add(command.input.TableName ?? '');
          return {};
        }
        if (command instanceof DescribeTimeToLiveCommand) {
          return {
            TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
          };
        }
        return {};
      });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      const created = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is CreateTableCommand =>
            command instanceof CreateTableCommand,
        );
      const ttlUpdates = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is UpdateTimeToLiveCommand =>
            command instanceof UpdateTimeToLiveCommand,
        );
      expect(created).toHaveLength(TABLE_DEFINITIONS.length);
      expect(ttlUpdates).toHaveLength(3);
      const ttlInputs = ttlUpdates.map((command) => command.input);
      expect(ttlInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            TableName: 'Clients',
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: 'expiresAt',
            },
          }),
          expect.objectContaining({
            TableName: 'Inbox',
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: 'expiresAt',
            },
          }),
          expect.objectContaining({
            TableName: 'Message',
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: 'expiresAt',
            },
          }),
        ]),
      );
      await module.close();
    });

    it('forces bootstrap on non-local endpoints with the flag', async () => {
      process.env.DYNAMODB_BOOTSTRAP = 'true';
      client.send.mockImplementation(async (command: unknown) => {
        if (command instanceof ListTablesCommand) {
          return { TableNames: [] };
        }
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              TableName: command.input.TableName,
              TableStatus: 'ACTIVE',
            },
          };
        }
        if (command instanceof DescribeTimeToLiveCommand) {
          return {
            TimeToLiveDescription: {
              TimeToLiveStatus: 'ENABLED',
              AttributeName: 'expiresAt',
            },
          };
        }
        return {};
      });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      const describes = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is DescribeTableCommand =>
            command instanceof DescribeTableCommand,
        );
      expect(describes.length).toBeGreaterThan(0);
      const ttlUpdates = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is UpdateTimeToLiveCommand =>
            command instanceof UpdateTimeToLiveCommand,
        );
      expect(ttlUpdates).toHaveLength(0);
      await module.close();
    });

    it('corrects TTL when enabled with the wrong attribute', async () => {
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
      client.send.mockImplementation(async (command: unknown) => {
        if (command instanceof ListTablesCommand) {
          return { TableNames: [] };
        }
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              TableName: command.input.TableName,
              TableStatus: 'ACTIVE',
            },
          };
        }
        if (command instanceof DescribeTimeToLiveCommand) {
          return {
            TimeToLiveDescription: {
              TimeToLiveStatus: 'ENABLED',
              AttributeName: 'ttl',
            },
          };
        }
        return {};
      });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      const ttlUpdates = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is UpdateTimeToLiveCommand =>
            command instanceof UpdateTimeToLiveCommand,
        );
      expect(ttlUpdates).toHaveLength(3);
      for (const update of ttlUpdates) {
        expect(update.input.TimeToLiveSpecification).toEqual({
          Enabled: true,
          AttributeName: 'expiresAt',
        });
      }
      await module.close();
    });

    it('continues boot with an error log when bootstrap fails', async () => {
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
      client.send.mockImplementation(async (command: unknown) => {
        if (command instanceof ListTablesCommand) {
          return { TableNames: [] };
        }
        throw Object.assign(new Error('access denied'), {
          name: 'AccessDeniedException',
        });
      });
      const errorSpy = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('continuing without ensured tables'),
      );
      await module.close();
    });

    it('reconciles TTL without recreating existing tables', async () => {
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
      client.send.mockImplementation(async (command: unknown) => {
        if (command instanceof ListTablesCommand) {
          return { TableNames: [] };
        }
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              TableName: command.input.TableName,
              TableStatus: 'ACTIVE',
            },
          };
        }
        if (command instanceof DescribeTimeToLiveCommand) {
          return {
            TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
          };
        }
        return {};
      });
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleInit();

      const created = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is CreateTableCommand =>
            command instanceof CreateTableCommand,
        );
      const ttlUpdates = client.send.mock.calls
        .map((call) => call[0])
        .filter(
          (command): command is UpdateTimeToLiveCommand =>
            command instanceof UpdateTimeToLiveCommand,
        );
      expect(created).toHaveLength(0);
      expect(ttlUpdates).toHaveLength(3);
      const ttlTables = ttlUpdates.map((command) => command.input.TableName);
      expect(ttlTables?.sort()).toEqual(['Clients', 'Inbox', 'Message']);
      await module.close();
    });
  });

  describe('ping', () => {
    it('resolves when DynamoDB answers', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await expect(service.ping()).resolves.toBeUndefined();
      expect(client.send).toHaveBeenCalledTimes(1);
      await module.close();
    });

    it('propagates client errors', async () => {
      client.send.mockRejectedValueOnce(new Error('Unreachable'));
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await expect(service.ping()).rejects.toThrow('Unreachable');
      await module.close();
    });
  });

  describe('onModuleDestroy', () => {
    it('destroys the client', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      await service.onModuleDestroy();

      expect(client.destroy).toHaveBeenCalledTimes(1);
      await module.close();
    });
  });

  describe('getClient', () => {
    it('returns the injected client', async () => {
      const module = await compile();
      service = module.get<DynamoService>(DynamoService);

      expect(service.getClient()).toBe(client as unknown as DynamoDBClient);
      await module.close();
    });
  });
});
