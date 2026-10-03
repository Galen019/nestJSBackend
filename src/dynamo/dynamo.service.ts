/**
 * Lifecycle wrapper around the injected DynamoDB client.
 *
 * - connects on module init by listing tables with bounded retries
 * - ensures ephemeral local tables from static definitions when gated on
 * - exposes `ping()`/`getClient()` for health checks and future domains.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { withBoundedRetry } from '../common/retry';
import { DYNAMO_CLIENT, getDynamoBootstrapConfig } from './dynamo.constants';
import { TABLE_DEFINITIONS } from './table-defs';

/**
 * Lifecycle wrapper around the injected `DYNAMO_CLIENT`.
 *
 * quits gracefully on module destroy
 * exposes `ping()`/`getClient()` for health checks and future domains.
 */
@Injectable()
export class DynamoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamoService.name);

  /**
   * Creates the service with the injected DynamoDB client.
   *
   * @param client Configured DynamoDB client pointing at local or AWS.
   */
  constructor(@Inject(DYNAMO_CLIENT) private readonly client: DynamoDBClient) {}

  /**
   * Pings DynamoDB then ensures local tables when the bootstrap gate allows.
   *
   * - delegates the retry policy to the shared `withBoundedRetry` helper
   * - probes via `ping()` so the readiness check has a single construction site
   * - the outer loop covers boot-time unavailability (compose waits only for
   *   `service_started`); the SDK's own per-request retries still cover
   *   transient failures inside each attempt
   * - skips table creation for non-local endpoints unless forced
   * - throws the last error when all attempts fail.
   *
   * @return Resolves when DynamoDB answers and tables are ensured.
   */
  async onModuleInit(): Promise<void> {
    await withBoundedRetry(() => this.ping(), {
      onAttemptFailed: (attempt, attempts) => {
        this.logger.warn(
          `DynamoDB connect attempt ${attempt}/${attempts} failed`,
        );
      },
      failureMessage: 'Failed to connect to DynamoDB after 10 attempts',
    });
    const bootstrap = getDynamoBootstrapConfig();
    if (!bootstrap.shouldBootstrap) {
      this.logger.log(
        `Skipping DynamoDB table bootstrap for non-local endpoint host ${bootstrap.hostname}`,
      );
      return;
    }
    await this.ensureTablesExist();
  }

  /**
   * Destroys the underlying DynamoDB client.
   */
  onModuleDestroy(): void {
    this.client.destroy();
  }

  /**
   * Pings DynamoDB for readiness probes.
   *
   * - sends `ListTables` with limit 1
   * - resolves without effect when DynamoDB answers
   * - rejects with the client error when DynamoDB is unreachable.
   *
   * @return Resolves on success.
   */
  async ping(): Promise<void> {
    await this.client.send(new ListTablesCommand({ Limit: 1 }));
  }

  /**
   * Returns the underlying client for future domains.
   *
   * @return The injected DynamoDB client.
   */
  getClient(): DynamoDBClient {
    return this.client;
  }

  /**
   * Ensures every static table exists with TTL reconciled per table.
   *
   * - iterates `TABLE_DEFINITIONS` sequentially to stay within local limits
   * - reconciles TTL right after its table is ACTIVE, including pre-existing
   *   tables, so each table is fully ensured before moving to the next.
   *
   * @return Resolves when all tables are active with TTL ensured.
   */
  private async ensureTablesExist(): Promise<void> {
    for (const table of TABLE_DEFINITIONS) {
      const tableName = table.create.TableName ?? '';
      await this.ensureTable(table.create);
      if (table.ttlAttribute !== undefined) {
        await this.ensureTtl(tableName, table.ttlAttribute);
      }
    }
    this.logger.log(`Ensured DynamoDB tables (${TABLE_DEFINITIONS.length})`);
  }

  /**
   * Ensures a single table exists and is active.
   *
   * - describes first so idempotent boots skip a doomed CreateTable call
   * - creates on ResourceNotFound, waits for ACTIVE otherwise
   * - treats ResourceInUse races as success and waits for ACTIVE
   * - throws when creation or activation fails after retries.
   *
   * @param definition CreateTable input from the static file.
   * @return Resolves when the table status is ACTIVE.
   */
  private async ensureTable(
    definition: CreateTableCommandInput,
  ): Promise<void> {
    const tableName = definition.TableName ?? '';
    try {
      const described = await this.client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      if (described.Table?.TableStatus === 'ACTIVE') {
        return;
      }
    } catch (err: unknown) {
      if (!isAwsError(err, 'ResourceNotFoundException')) {
        throw err;
      }
      try {
        await this.client.send(new CreateTableCommand(definition));
      } catch (createErr: unknown) {
        if (!isAwsError(createErr, 'ResourceInUseException')) {
          throw createErr;
        }
      }
    }
    await this.waitUntilActive(tableName);
  }

  /**
   * Waits until a table reports ACTIVE.
   *
   * - polls DescribeTable with the shared bounded-retry policy
   * - throws when the table never becomes ACTIVE.
   *
   * @param tableName Table to poll.
   * @return Resolves when the table status is ACTIVE.
   */
  private async waitUntilActive(tableName: string): Promise<void> {
    await withBoundedRetry(
      async () => {
        const described = await this.client.send(
          new DescribeTableCommand({ TableName: tableName }),
        );
        if (described.Table?.TableStatus !== 'ACTIVE') {
          throw new Error(`Table ${tableName} is not ACTIVE yet`);
        }
      },
      {
        onAttemptFailed: (attempt, attempts) => {
          this.logger.warn(
            `DynamoDB table ${tableName} activation attempt ${attempt}/${attempts} pending`,
          );
        },
        failureMessage: `Table ${tableName} did not become ACTIVE`,
      },
    );
  }

  /**
   * Ensures TTL is enabled for a table with the desired attribute.
   *
   * - no-ops when TTL is already ENABLED or ENABLING
   * - enables via UpdateTimeToLive otherwise.
   *
   * @param tableName Table to reconcile.
   * @param attributeName TTL attribute holding epoch seconds.
   * @return Resolves when TTL is enabled.
   */
  private async ensureTtl(
    tableName: string,
    attributeName: string,
  ): Promise<void> {
    const described = await this.client.send(
      new DescribeTimeToLiveCommand({ TableName: tableName }),
    );
    const status = described.TimeToLiveDescription?.TimeToLiveStatus;
    if (status === 'ENABLED' || status === 'ENABLING') {
      return;
    }
    await this.client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: attributeName,
        },
      }),
    );
  }
}

/**
 * Checks whether an SDK error carries the given exception name.
 *
 * - matches against both `name` and `code` because SDK faults vary by path
 * - non-object failures never match.
 *
 * @param err Unknown client failure.
 * @param code Exception name to match.
 * @return True when the error matches by name or code.
 */
function isAwsError(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const record = err as { name?: unknown; code?: unknown };
  return record.name === code || record.code === code;
}
