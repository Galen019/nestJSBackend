/** DynamoDB injection token and environment configuration. */
import { parseEnvFlag } from '../common/env';

export const DYNAMO_CLIENT = 'DYNAMO_CLIENT';

/** Resolved DynamoDB connection settings. */
export interface DynamoConfig {
  endpoint: string;
  hostname: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const DEFAULT_DYNAMODB_ENDPOINT = 'http://localhost:8000';
const DEFAULT_AWS_REGION = 'us-east-1';
const DEFAULT_DUMMY_CREDENTIAL = 'local';

/**
 * Uses dummy credentials when the environment value is empty.
 *
 * @param value Raw env value.
 * @return The credential or local default.
 */
function orLocalCredential(value: string | undefined): string {
  if (value === undefined || value === '') {
    return DEFAULT_DUMMY_CREDENTIAL;
  }
  return value;
}

/**
 * Resolves DynamoDB settings from the environment and local defaults.
 *
 * @return The resolved DynamoDB config.
 */
export function getDynamoConfig(): DynamoConfig {
  const rawEndpoint =
    process.env.DYNAMODB_ENDPOINT ?? DEFAULT_DYNAMODB_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new Error(`Invalid DYNAMODB_ENDPOINT: ${rawEndpoint}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid DYNAMODB_ENDPOINT: ${rawEndpoint}`);
  }
  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  if (region.trim().length === 0) {
    throw new Error('Invalid AWS_REGION: must be a non-empty string');
  }
  const accessKeyId = orLocalCredential(process.env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = orLocalCredential(process.env.AWS_SECRET_ACCESS_KEY);
  return {
    endpoint: rawEndpoint,
    hostname: parsed.hostname,
    region,
    accessKeyId,
    secretAccessKey,
  };
}

/** Hostnames recognized as local DynamoDB targets. */
export const LOCAL_DYNAMO_HOSTNAMES: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'dynamodb',
  'host.docker.internal',
];

/** Resolved table-bootstrap decision. */
export interface DynamoBootstrapConfig {
  hostname: string;
  shouldBootstrap: boolean;
}

/**
 * Checks a hostname against the local DynamoDB allowlist.
 *
 * @param hostname URL hostname from the configured endpoint.
 * @return Whether the hostname is local.
 */
export function isLocalDynamoHostname(hostname: string): boolean {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return LOCAL_DYNAMO_HOSTNAMES.includes(normalized);
}

/**
 * Enables bootstrap for local endpoints or via `DYNAMODB_BOOTSTRAP`.
 *
 * @return The endpoint hostname and the effective decision.
 */
export function getDynamoBootstrapConfig(): DynamoBootstrapConfig {
  const config = getDynamoConfig();
  return {
    hostname: config.hostname,
    shouldBootstrap:
      isLocalDynamoHostname(config.hostname) ||
      parseEnvFlag(process.env.DYNAMODB_BOOTSTRAP),
  };
}
