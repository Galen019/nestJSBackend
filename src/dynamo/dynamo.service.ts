/** DynamoDB connection, local table bootstrap, and client lifecycle. */
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
import { isAwsError } from '../common/aws-error';
import { DYNAMO_CLIENT, getDynamoBootstrapConfig } from './dynamo.constants';
import { TABLE_DEFINITIONS } from './table-defs';

/** Manages the injected client and exposes readiness and access helpers. */
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
   * Retries readiness checks, then bootstraps local tables when enabled.
   * Connection failures abort startup; bootstrap failures are logged and tolerated.
   *
   * @return Resolves when DynamoDB answers; table setup is best-effort.
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
    try {
      await this.ensureTablesExist();
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(
        `DynamoDB table bootstrap failed, continuing without ensured tables: ${detail}. ` +
          `Bootstrap requires dynamodb:CreateTable, dynamodb:DescribeTable, ` +
          `dynamodb:DescribeTimeToLive, and dynamodb:UpdateTimeToLive on the configured endpoint.`,
      );
    }
  }

  /**
   * Destroys the underlying DynamoDB client.
   */
  onModuleDestroy(): void {
    this.client.destroy();
  }

  /**
   * Checks DynamoDB readiness with a one-item `ListTables` request.
   *
   * @return Resolves on success.
   */
  async ping(): Promise<void> {
    await this.client.send(new ListTablesCommand({ Limit: 1 }));
  }

  /** @return The injected DynamoDB client. */
  getClient(): DynamoDBClient {
    return this.client;
  }

  /**
   * Ensures each static table exists and reconciles its TTL.
   *
   * @return Resolves when all tables are active and TTL is configured.
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
   * Creates a missing table and waits for it to become active.
   *
   * @param definition Static CreateTable input.
   * @return Resolves when the table is active.
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

  /** Polls until a table becomes active or retries are exhausted.
   *
   * @param tableName Table to poll.
   * @return Resolves when the table is active.
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
   * Enables TTL with the requested attribute, correcting mismatches.
   *
   * @param tableName Table to reconcile.
   * @param attributeName Attribute containing expiration timestamps.
   * @return Resolves when TTL is configured.
   */
  private async ensureTtl(
    tableName: string,
    attributeName: string,
  ): Promise<void> {
    const described = await this.client.send(
      new DescribeTimeToLiveCommand({ TableName: tableName }),
    );
    const description = described.TimeToLiveDescription;
    const status = description?.TimeToLiveStatus;
    if (
      (status === 'ENABLED' || status === 'ENABLING') &&
      description?.AttributeName === attributeName
    ) {
      return;
    }
    if (status === 'ENABLED' || status === 'ENABLING') {
      this.logger.warn(
        `DynamoDB table ${tableName} TTL uses attribute ${description?.AttributeName ?? 'unknown'}, reconciling to ${attributeName}`,
      );
    } else {
      this.logger.log(
        `Enabling DynamoDB TTL on table ${tableName} with attribute ${attributeName}`,
      );
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
