/**
 * Test suite for DynamoDB env config resolution.
 *
 * - getDynamoConfig: local defaults, env overrides, invalid endpoint or region
 * - isLocalDynamoHostname: allowlist matching, bracketed IPv6, and blanks
 * - getDynamoBootstrapConfig: local gate and DYNAMODB_BOOTSTRAP override
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDynamoBootstrapConfig,
  getDynamoConfig,
  isLocalDynamoHostname,
} from './dynamo.constants';

describe('getDynamoConfig', () => {
  /**
   * Snapshots env so each case starts from a clean slate.
   */
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DYNAMODB_ENDPOINT;
    delete process.env.DYNAMODB_BOOTSTRAP;
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
      hostname: 'localhost',
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
      hostname: 'dynamodb',
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

describe('isLocalDynamoHostname', () => {
  it('allows known local hostnames', () => {
    expect(isLocalDynamoHostname('localhost')).toBe(true);
    expect(isLocalDynamoHostname('127.0.0.1')).toBe(true);
    expect(isLocalDynamoHostname('dynamodb')).toBe(true);
    expect(isLocalDynamoHostname('host.docker.internal')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isLocalDynamoHostname('LOCALHOST')).toBe(true);
  });

  it('matches bracketed IPv6 loopback from URL.hostname', () => {
    expect(isLocalDynamoHostname('::1')).toBe(true);
    expect(isLocalDynamoHostname('[::1]')).toBe(true);
  });

  it('rejects prod hostnames and blanks', () => {
    expect(isLocalDynamoHostname('dynamodb.us-east-1.amazonaws.com')).toBe(
      false,
    );
    expect(isLocalDynamoHostname('   ')).toBe(false);
  });
});

describe('getDynamoBootstrapConfig', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DYNAMODB_ENDPOINT;
    delete process.env.DYNAMODB_BOOTSTRAP;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('bootstraps by default on localhost', () => {
    const config = getDynamoBootstrapConfig();

    expect(config.hostname).toBe('localhost');
    expect(config.shouldBootstrap).toBe(true);
  });

  it('skips non-local endpoints without the flag', () => {
    process.env.DYNAMODB_ENDPOINT = 'https://dynamo.prod.example.com';

    expect(getDynamoBootstrapConfig().shouldBootstrap).toBe(false);
  });

  it('forces bootstrap on non-local endpoints with the flag', () => {
    process.env.DYNAMODB_ENDPOINT = 'https://dynamo.prod.example.com';
    process.env.DYNAMODB_BOOTSTRAP = 'true';

    const config = getDynamoBootstrapConfig();

    expect(config.shouldBootstrap).toBe(true);
  });

  it('bootstraps bracketed IPv6 loopback endpoints', () => {
    process.env.DYNAMODB_ENDPOINT = 'http://[::1]:8000';

    const config = getDynamoBootstrapConfig();

    expect(config.shouldBootstrap).toBe(true);
  });
});
