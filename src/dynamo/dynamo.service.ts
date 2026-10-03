/**
 * Lifecycle wrapper around the injected DynamoDB client.
 *
 * - connects on module init by listing tables with bounded retries
 * - exposes `ping()`/`getClient()` for health checks and future domains.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { withBoundedRetry } from '../common/retry';
import { DYNAMO_CLIENT } from './dynamo.constants';

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
   * Pings DynamoDB on module init with bounded exponential-backoff retries.
   *
   * - delegates the retry policy to the shared `withBoundedRetry` helper
   * - probes via `ping()` so the readiness check has a single construction site
   * - the outer loop covers boot-time unavailability (compose waits only for
   *   `service_started`); the SDK's own per-request retries still cover
   *   transient failures inside each attempt
   * - throws the last error when all attempts fail.
   *
   * @return Resolves when DynamoDB answers.
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
}
