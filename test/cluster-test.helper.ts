/**
 * Test-only cluster Redis fake with a shared claim store.
 *
 * - stores the bare claim token exactly like Redis does in production
 * - interprets the real Lua script text, so release and renewal cannot be
 *   faked by checking a script constant and returning a canned result
 */
import { vi } from 'vitest';
import type { ClusterCommandClient } from '../src/cluster/cluster.service';

/** Script arguments as passed through `EVAL`. */
interface ScriptOptions {
  /** Redis keys referenced by the script. */
  keys: string[];
  /** Redis arguments referenced by the script. */
  arguments: string[];
}

/** The supported claim-script shape: guarded GET plus one mutating call. */
const CLAIM_SCRIPT_PATTERN =
  /^if\s+redis\.call\('get',\s*KEYS\[(\d+)\]\)\s*==\s*ARGV\[(\d+)\]\s+then\s+return\s+redis\.call\('(del|expire)',\s*KEYS\[(\d+)\](?:,\s*ARGV\[(\d+)\])?\)\s+else\s+return\s+(\d+)\s+end$/;

/**
 * Reads an indexed script value.
 *
 * @param values Key or argument list from `EVAL`.
 * @param index Index referenced by the script.
 * @param label Value name used in failure messages.
 * @return The referenced value.
 */
function requireValue(
  values: readonly string[],
  index: number,
  label: string,
): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing ${label}[${index}] in claim script call`);
  }
  return value;
}

/**
 * Parses a numeric script index or result.
 *
 * @param raw Captured script text.
 * @param label Value name used in failure messages.
 * @return The parsed non-negative integer.
 */
function requireNumber(raw: string | undefined, label: string): number {
  if (raw === undefined) {
    throw new Error(`Missing ${label} in claim script`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} in claim script: ${raw}`);
  }
  return value;
}

/**
 * Parses a one-based Redis script index.
 *
 * @param raw Captured script text.
 * @param label Value name used in failure messages.
 * @return The zero-based array index.
 */
function requireIndex(raw: string | undefined, label: string): number {
  const value = requireNumber(raw, label);
  if (value === 0) {
    throw new Error(`Redis script indexes are one-based: ${label}`);
  }
  return value - 1;
}

/**
 * Executes the supported claim-script shape against an in-memory store.
 *
 * - parses the script text instead of comparing it to an exported constant
 * - a value mismatch follows the script's `else` branch, which is what catches
 *   a claim stored as JSON rather than the bare token
 *
 * @param script Lua script passed to `EVAL`.
 * @param options Keys and arguments passed to `EVAL`.
 * @param store Claim values shared by all replica fakes.
 * @return The script's numeric Redis reply.
 */
export function executeClaimScript(
  script: string,
  options: ScriptOptions,
  store: Map<string, string>,
): number {
  const match = CLAIM_SCRIPT_PATTERN.exec(script.trim());
  if (match === null) {
    throw new Error(`Unsupported claim script shape: ${script}`);
  }
  const conditionIndex = requireIndex(match[1], 'condition key index');
  const tokenIndex = requireIndex(match[2], 'token argument index');
  const conditionKey = requireValue(options.keys, conditionIndex, 'KEYS');
  const expectedToken = requireValue(options.arguments, tokenIndex, 'ARGV');
  const command = match[3];
  if (command !== 'del' && command !== 'expire') {
    throw new Error(`Unsupported claim script command: ${command ?? 'none'}`);
  }
  const commandIndex = requireIndex(match[4], 'command key index');
  const commandKey = requireValue(options.keys, commandIndex, 'KEYS');
  if (commandKey !== conditionKey) {
    throw new Error('Claim script mutates a different key than it checks');
  }
  const elseResult = requireNumber(match[6], 'else result');
  if (store.get(conditionKey) !== expectedToken) {
    return elseResult;
  }

  if (command === 'del') {
    store.delete(commandKey);
    return 1;
  }
  const ttlIndex = requireIndex(match[5], 'expiry argument index');
  const ttl = Number(requireValue(options.arguments, ttlIndex, 'ARGV'));
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`Invalid claim TTL: ${String(ttl)}`);
  }
  return 1;
}

/**
 * In-memory cluster client with its backing claim store.
 */
export interface ClusterFake {
  /** Command client handed to ClusterService. */
  client: ClusterCommandClient;
  /** Claim values shared by all replicas in one test. */
  store: Map<string, string>;
}

/**
 * Creates a cluster command fake with NX and script-driven semantics.
 *
 * @param store Optional claim store shared with other replica fakes.
 * @return The fake client plus its store.
 */
export function createClusterFake(
  store: Map<string, string> = new Map<string, string>(),
): ClusterFake {
  let open = false;
  const client = {
    get isOpen(): boolean {
      return open;
    },
    connect: vi.fn<() => Promise<void>>().mockImplementation(async () => {
      open = true;
    }),
    quit: vi.fn<() => Promise<string>>().mockImplementation(async () => {
      open = false;
      return 'OK';
    }),
    on: vi.fn<(event: string, listener: (err: Error) => void) => unknown>(),
    set: vi
      .fn<
        (
          key: string,
          value: string,
          options: { NX: boolean; EX: number },
        ) => Promise<string | null>
      >()
      .mockImplementation(
        async (
          key: string,
          value: string,
          options: { NX: boolean; EX: number },
        ): Promise<string | null> => {
          void options.EX;
          if (options.NX && store.has(key)) {
            return null;
          }
          store.set(key, value);
          return 'OK';
        },
      ),
    eval: vi
      .fn<
        (
          script: string,
          options: { keys: string[]; arguments: string[] },
        ) => Promise<unknown>
      >()
      .mockImplementation(
        async (
          script: string,
          options: { keys: string[]; arguments: string[] },
        ): Promise<unknown> => executeClaimScript(script, options, store),
      ),
  } satisfies ClusterCommandClient;
  return { client, store };
}
