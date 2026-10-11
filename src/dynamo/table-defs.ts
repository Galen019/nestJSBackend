/** Table schemas for local bootstrap, including post-create TTL settings. */
import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { TTL_ATTRIBUTE_NAME } from './ttl';

/** CreateTable input with an optional TTL attribute. */
export interface TableDefinition {
  /** Input for CreateTable. */
  create: CreateTableCommandInput;
  /** Reconciled after table activation; omitted when TTL is unused. */
  ttlAttribute?: string;
}

/**
 * Adds PAY_PER_REQUEST billing and an optional TTL attribute.
 *
 * @param create CreateTable input without billing mode.
 * @param ttlAttribute Optional TTL attribute.
 * @return Completed table definition.
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
 * - Inbox/Message/Clients expire via `expiresAt`, reconciled on every boot
 * - User is a permanent registry by design: no TTL, no delete on disconnect.
 */
export const TABLE_DEFINITIONS: TableDefinition[] = [
  defineTable({
    TableName: 'User',
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  }),
  defineTable(
    {
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
    },
    TTL_ATTRIBUTE_NAME,
  ),
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
