/**
 * Test suite for static DynamoDB table definitions.
 *
 * - guards the seven-table contract, key schemas, and GSI shapes
 * - asserts PAY_PER_REQUEST billing and TTL attachment for Inbox/Message only.
 */
import { describe, it, expect } from 'vitest';
import type { GlobalSecondaryIndex } from '@aws-sdk/client-dynamodb';
import { TABLE_DEFINITIONS } from './table-defs';
import { TTL_ATTRIBUTE_NAME } from './ttl';

describe('table-defs', () => {
  it('defines exactly seven tables', () => {
    expect(
      TABLE_DEFINITIONS.map((table) => table.create.TableName).sort(),
    ).toEqual(
      [
        'Chat',
        'Clients',
        'Inbox',
        'LastSeen',
        'Member',
        'Message',
        'User',
      ].sort(),
    );
  });

  it('uses PAY_PER_REQUEST billing everywhere', () => {
    for (const table of TABLE_DEFINITIONS) {
      expect(table.create.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });

  it('defines primary keys as agreed', () => {
    const byName = Object.fromEntries(
      TABLE_DEFINITIONS.map((table) => [table.create.TableName, table.create]),
    );
    expect(byName.User.KeySchema).toEqual([
      { AttributeName: 'userId', KeyType: 'HASH' },
    ]);
    expect(byName.Clients.KeySchema).toEqual([
      { AttributeName: 'clientId', KeyType: 'HASH' },
    ]);
    expect(byName.LastSeen.KeySchema).toEqual([
      { AttributeName: 'userId', KeyType: 'HASH' },
    ]);
    expect(byName.Chat.KeySchema).toEqual([
      { AttributeName: 'chatId', KeyType: 'HASH' },
    ]);
    expect(byName.Member.KeySchema).toEqual([
      { AttributeName: 'chatId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ]);
    expect(byName.Inbox.KeySchema).toEqual([
      { AttributeName: 'clientId', KeyType: 'HASH' },
      { AttributeName: 'messageId', KeyType: 'RANGE' },
    ]);
    expect(byName.Message.KeySchema).toEqual([
      { AttributeName: 'messageId', KeyType: 'HASH' },
    ]);
  });

  it('defines GSIs for user and chat access patterns', () => {
    const byName = Object.fromEntries(
      TABLE_DEFINITIONS.map((table) => [table.create.TableName, table.create]),
    );
    expect(
      byName.Clients.GlobalSecondaryIndexes?.map(
        (index: GlobalSecondaryIndex) => index.IndexName,
      ),
    ).toEqual(['ClientsByUser']);
    expect(
      byName.Member.GlobalSecondaryIndexes?.map(
        (index: GlobalSecondaryIndex) => index.IndexName,
      ),
    ).toEqual(['MembersByUser']);
    expect(
      byName.Message.GlobalSecondaryIndexes?.map(
        (index: GlobalSecondaryIndex) => index.IndexName,
      ),
    ).toEqual(['MessagesByChat']);
    expect(byName.User.GlobalSecondaryIndexes).toBeUndefined();
    expect(byName.Chat.GlobalSecondaryIndexes).toBeUndefined();
    expect(byName.LastSeen.GlobalSecondaryIndexes).toBeUndefined();
    expect(byName.Inbox.GlobalSecondaryIndexes).toBeUndefined();

    const messagesByChat = byName.Message.GlobalSecondaryIndexes?.find(
      (index: GlobalSecondaryIndex) => index.IndexName === 'MessagesByChat',
    );
    expect(messagesByChat?.KeySchema).toEqual([
      { AttributeName: 'chatId', KeyType: 'HASH' },
      { AttributeName: 'timestamp', KeyType: 'RANGE' },
    ]);
    for (const table of TABLE_DEFINITIONS) {
      for (const index of table.create.GlobalSecondaryIndexes ?? []) {
        expect(index.Projection?.ProjectionType).toBe('ALL');
      }
    }
  });

  it('declares key attributes with string and number types', () => {
    const message = TABLE_DEFINITIONS.find(
      (table) => table.create.TableName === 'Message',
    );
    const attrs = Object.fromEntries(
      (message?.create.AttributeDefinitions ?? []).map((attr) => [
        attr.AttributeName,
        attr.AttributeType,
      ]),
    );
    expect(attrs.messageId).toBe('S');
    expect(attrs.chatId).toBe('S');
    expect(attrs.timestamp).toBe('N');
  });

  it('attaches TTL only to Inbox and Message via expiresAt', () => {
    const byName = Object.fromEntries(
      TABLE_DEFINITIONS.map((table) => [table.create.TableName, table]),
    );
    expect(byName.Inbox.ttlAttribute).toBe(TTL_ATTRIBUTE_NAME);
    expect(byName.Message.ttlAttribute).toBe(TTL_ATTRIBUTE_NAME);
    for (const name of ['User', 'Clients', 'LastSeen', 'Chat', 'Member']) {
      expect(byName[name].ttlAttribute).toBeUndefined();
    }
  });
});
