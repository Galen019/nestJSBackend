/**
 * Static DynamoDB table definitions for ephemeral local bootstrap.
 *
 * - single source of truth for `ensure-exists` table creation on startup
 * - seven tables; `defineTable` injects PAY_PER_REQUEST billing structurally
 * - TTL rides on the table entry (`ttlAttribute`); CreateTable has no TTL
 *   field, so the service reconciles it via TimeToLive after the table is ACTIVE
 * - attribute docs: ids/names as S, timestamps as N
 */
import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { TTL_ATTRIBUTE_NAME } from './ttl';

/**
 * Static table shape: CreateTable input plus optional TTL attribute.
 */
export interface TableDefinition {
  /** CreateTable input sent on bootstrap. */
  create: CreateTableCommandInput;
  /** TTL attribute reconciled after the table is ACTIVE; absent means no TTL. */
  ttlAttribute?: string;
}

/**
 * Builds a table definition with PAY_PER_REQUEST billing.
 *
 * - injects the billing mode so call sites cannot drift from it
 * - attaches the TTL attribute for expiring tables only.
 *
 * @param create CreateTable input without the billing mode.
 * @param ttlAttribute TTL attribute for expiring tables.
 * @return The table definition with billing applied.
 */
function defineTable(
  create: Omit<CreateTableCommandInput, 'BillingMode'>,
  ttlAttribute?: string,
): TableDefinition {
  const withBilling: CreateTableCommandInput = {
    ...create,
    BillingMode: 'PAY_PER_REQUEST',
  };
  if (ttlAttribute === undefined) {
    return { create: withBilling };
  }
  return { create: withBilling, ttlAttribute };
}

/**
 * All seven domain tables with key schemas and TTL attachment.
 *
 * - User PK=userId, LastSeen PK=userId, Chat PK=chatId
 * - Clients PK=clientId + GSI ClientsByUser(userId, clientId)
 * - Member PK=(chatId, userId) + GSI MembersByUser(userId, chatId)
 * - Inbox PK=(clientId, messageId), no GSI (inbox-by-client is a PK query)
 * - Message PK=messageId + GSI MessagesByChat(chatId, timestamp)
 * - Inbox/Message expire via `expiresAt`, reconciled on every boot.
 */
export const TABLE_DEFINITIONS: TableDefinition[] = [
  defineTable({
    TableName: 'User',
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  }),
  defineTable({
    TableName: 'Clients',
    AttributeDefinitions: [
      { AttributeName: 'clientId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'clientId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ClientsByUser',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'clientId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  }),
  defineTable({
    TableName: 'LastSeen',
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  }),
  defineTable({
    TableName: 'Chat',
    AttributeDefinitions: [{ AttributeName: 'chatId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'chatId', KeyType: 'HASH' }],
  }),
  defineTable({
    TableName: 'Member',
    AttributeDefinitions: [
      { AttributeName: 'chatId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'chatId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'MembersByUser',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'chatId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  }),
  defineTable(
    {
      TableName: 'Inbox',
      AttributeDefinitions: [
        { AttributeName: 'clientId', AttributeType: 'S' },
        { AttributeName: 'messageId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'clientId', KeyType: 'HASH' },
        { AttributeName: 'messageId', KeyType: 'RANGE' },
      ],
    },
    TTL_ATTRIBUTE_NAME,
  ),
  defineTable(
    {
      TableName: 'Message',
      AttributeDefinitions: [
        { AttributeName: 'messageId', AttributeType: 'S' },
        { AttributeName: 'chatId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'N' },
      ],
      KeySchema: [{ AttributeName: 'messageId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'MessagesByChat',
          KeySchema: [
            { AttributeName: 'chatId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    },
    TTL_ATTRIBUTE_NAME,
  ),
];
