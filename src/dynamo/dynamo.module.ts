/**
 * DynamoDB DI module.
 *
 * - Provides DYNAMO_CLIENT via factory from env
 * - Registers/exports DynamoService
 * - Endpoint: local container URL, region plus dummy local credentials
 */
import { Module } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DYNAMO_CLIENT, getDynamoConfig } from './dynamo.constants';
import { DynamoService } from './dynamo.service';

/**
 * DynamoDB DI module.
 *
 * - Provides DYNAMO_CLIENT via factory from env
 * - Registers and exports DynamoService for health and future domains.
 */
@Module({
  providers: [
    {
      provide: DYNAMO_CLIENT,
      useFactory: (): DynamoDBClient => {
        const config = getDynamoConfig();
        return new DynamoDBClient({
          endpoint: config.endpoint,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        });
      },
    },
    DynamoService,
  ],
  exports: [DYNAMO_CLIENT, DynamoService],
})
export class DynamoModule {}
