/**
 * DynamoDB DI token and env config.
 *
 * - DYNAMO_CLIENT: injection token
 * - getDynamoConfig: reads DYNAMODB_ENDPOINT/AWS_* env, parses the URL once
 * - getDynamoBootstrapConfig: local-only gate plus DYNAMODB_BOOTSTRAP override
 */
import { parseEnvFlag } from '../common/env';

export const DYNAMO_CLIENT = 'DYNAMO_CLIENT';

/**
 * Resolved DynamoDB connection settings.
 */
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
 * Resolves a credential env value with the dummy local fallback.
 *
 * - blank and missing values fall back so local boots need no AWS keys
 * - non-blank values pass through untouched.
 *
 * @param value Raw env value.
 * @return The credential or the local default.
 */
function orLocalCredential(value: string | undefined): string {
  if (value === undefined || value === '') {
    return DEFAULT_DUMMY_CREDENTIAL;
  }
  return value;
}

/**
 * Reads DynamoDB config from the environment with local defaults.
 *
 * - endpoint defaults to the local DynamoDB container port
 * - region defaults to us-east-1, credentials default to dummy locals
 * - exposes the parsed hostname so the bootstrap gate never re-parses the URL
 * - throws when the endpoint is not a valid URL or region is blank.
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

/**
 * Hostnames treated as ephemeral local DynamoDB targets.
 */
export const LOCAL_DYNAMO_HOSTNAMES: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'dynamodb',
  'host.docker.internal',
];

/**
 * Resolved bootstrap gate for ensure-exists table creation.
 */
export interface DynamoBootstrapConfig {
  hostname: string;
  shouldBootstrap: boolean;
}

/**
 * Checks whether a hostname is an allowed local DynamoDB target.
 *
 * - compares case-insensitively against the local allowlist
 * - strips IPv6 brackets because `URL.hostname` returns `[::1]` bracketed
 * - unknown or empty hostnames never count as local.
 *
 * @param hostname URL hostname from the configured endpoint.
 * @return True when the hostname is a known local target.
 */
export function isLocalDynamoHostname(hostname: string): boolean {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return LOCAL_DYNAMO_HOSTNAMES.includes(normalized);
}

/**
 * Resolves whether startup table bootstrap should run.
 *
 * - bootstraps when the endpoint hostname is local
 * - DYNAMODB_BOOTSTRAP forces bootstrap for non-local endpoints via the
 *   canonical `parseEnvFlag` truthy set (`true`/`1`/`yes`)
 * - never throws for a missing flag; invalid endpoints still throw via getDynamoConfig.
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
