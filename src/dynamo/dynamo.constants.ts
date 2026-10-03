/**
 * DynamoDB DI token and env config.
 *
 * - DYNAMO_CLIENT: injection token
 * - getDynamoConfig: reads DYNAMODB_ENDPOINT/AWS_* env
 */
export const DYNAMO_CLIENT = 'DYNAMO_CLIENT';

/**
 * Resolved DynamoDB connection settings.
 */
export interface DynamoConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const DEFAULT_DYNAMODB_ENDPOINT = 'http://localhost:8000';
const DEFAULT_AWS_REGION = 'us-east-1';
const DEFAULT_DUMMY_CREDENTIAL = 'local';

/**
 * Reads DynamoDB config from the environment with local defaults.
 *
 * - endpoint defaults to the local DynamoDB container port
 * - region defaults to us-east-1, credentials default to dummy locals
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
  const accessKeyId =
    process.env.AWS_ACCESS_KEY_ID === undefined ||
    process.env.AWS_ACCESS_KEY_ID === ''
      ? DEFAULT_DUMMY_CREDENTIAL
      : process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY === undefined ||
    process.env.AWS_SECRET_ACCESS_KEY === ''
      ? DEFAULT_DUMMY_CREDENTIAL
      : process.env.AWS_SECRET_ACCESS_KEY;
  return {
    endpoint: rawEndpoint,
    region,
    accessKeyId,
    secretAccessKey,
  };
}
