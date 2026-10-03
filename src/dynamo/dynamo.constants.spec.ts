/**
 * Test suite for DynamoDB env config resolution.
 *
 * - getDynamoConfig: local defaults, env overrides, invalid endpoint or region
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDynamoConfig } from './dynamo.constants';

describe('getDynamoConfig', () => {
  /**
   * Snapshots env so each case starts from a clean slate.
   */
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DYNAMODB_ENDPOINT;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('resolves local defaults when env is unset', () => {
    expect(getDynamoConfig()).toEqual({
      endpoint: 'http://localhost:8000',
      region: 'us-east-1',
      accessKeyId: 'local',
      secretAccessKey: 'local',
    });
  });

  it('honours endpoint, region, and credential overrides', () => {
    process.env.DYNAMODB_ENDPOINT = 'http://dynamodb:8000';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_ACCESS_KEY_ID = 'key';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';

    expect(getDynamoConfig()).toEqual({
      endpoint: 'http://dynamodb:8000',
      region: 'eu-west-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
  });

  it('throws on a non-URL endpoint', () => {
    process.env.DYNAMODB_ENDPOINT = 'not-a-url';

    expect(() => getDynamoConfig()).toThrow('Invalid DYNAMODB_ENDPOINT');
  });

  it('throws on a blank region', () => {
    process.env.AWS_REGION = '   ';

    expect(() => getDynamoConfig()).toThrow('Invalid AWS_REGION');
  });
});
