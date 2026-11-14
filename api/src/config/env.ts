/**
 * Every environment variable `api/src` reads, validated once at boot by `main.ts` and `worker.ts`
 * before Nest starts, so a typo or a missing value stops the process with one clear error instead
 * of surfacing as `NaN` or `undefined` at first use. Modules still read `process.env` where they
 * use it (CLAUDE.md "Config"); this file only checks what they will find there.
 *
 * Add a variable here in the same change that first reads it, and to `.env.example`
 * (`api/tests/unit/config/env.test.ts` fails when the two drift apart).
 */

/** The two processes `api/src` builds: the internet-facing HTTP API and the worker. */
export type ProcessKind = 'api' | 'worker';

type Kind =
  | { type: 'string' }
  | { type: 'url'; protocols: string[] }
  | { type: 'int'; min: number }
  | { type: 'bool' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'base64Key32' };

interface EnvVarSpec {
  name: string;
  kind: Kind;
  /** Processes that read it. A variable is only checked for the process that reads it. */
  readBy: readonly ProcessKind[];
  /**
   * Feature secrets the process can boot without: unset only disables that feature, which answers
   * 503 until it is configured (CLAUDE.md: secrets are read lazily). Boot logs which are unset.
   */
  optionalFeature?: string;
}

const API: readonly ProcessKind[] = ['api'];
const WORKER: readonly ProcessKind[] = ['worker'];
const BOTH: readonly ProcessKind[] = ['api', 'worker'];
const positive = { type: 'int', min: 1 } as const;
const bool = { type: 'bool' } as const;
const text = { type: 'string' } as const;

export const SUI_NETWORKS = ['testnet', 'mainnet'] as const;

export const ENV_SCHEMA: readonly EnvVarSpec[] = [
  // HTTP server
  { name: 'API_HOST', kind: text, readBy: API },
  { name: 'API_PORT', kind: { type: 'int', min: 0 }, readBy: API },
  { name: 'TRUSTED_PROXY_HOPS', kind: { type: 'int', min: 0 }, readBy: API },
  { name: 'RATE_LIMIT_MAX_REQUESTS', kind: positive, readBy: API },
  { name: 'PUBLIC_RATE_LIMIT_MAX_REQUESTS', kind: positive, readBy: API },
  { name: 'OPENAPI_ENABLED', kind: bool, readBy: API },
  { name: 'ORG_SLUG_ENTRY_ENABLED', kind: bool, readBy: API },
  // Storage
  { name: 'DATABASE_URL', kind: { type: 'url', protocols: ['postgres:', 'postgresql:'] }, readBy: BOTH },
  { name: 'DB_MAX_CONNECTIONS', kind: positive, readBy: BOTH },
  { name: 'REDIS_URL', kind: { type: 'url', protocols: ['redis:', 'rediss:'] }, readBy: BOTH },
  // Chain
  { name: 'SUI_NETWORK', kind: { type: 'enum', values: SUI_NETWORKS }, readBy: BOTH },
  { name: 'AWS_REGION', kind: text, readBy: WORKER },
  { name: 'SUI_ISSUER_KMS_KEY_ID', kind: text, readBy: WORKER },
  { name: 'SUI_ISSUER_PRIVATE_KEY', kind: text, readBy: WORKER },
  { name: 'SUI_PROGRAM_ADMIN_KMS_KEY_ID', kind: text, readBy: WORKER },
  { name: 'SUI_PROGRAM_ADMIN_PRIVATE_KEY', kind: text, readBy: WORKER },
  // HTTP-process feature secrets
  { name: 'ENOKI_API_KEY', kind: text, readBy: API, optionalFeature: 'zkLogin and sponsored transactions' },
  { name: 'CONSOLE_GOOGLE_CLIENT_ID', kind: text, readBy: API, optionalFeature: 'console Google sign-in' },
  {
    name: 'ORGANIZATION_IDENTITY_ENCRYPTION_KEY',
    kind: { type: 'base64Key32' },
    readBy: API,
    optionalFeature: 'CCCD storage',
  },
  // Worker tuning
  { name: 'CHAIN_SUBMIT_POLL_INTERVAL_MS', kind: positive, readBy: WORKER },
  { name: 'CHAIN_SUBMIT_BATCH_SIZE', kind: positive, readBy: WORKER },
  { name: 'CHAIN_SUBMIT_STALE_PROCESSING_MS', kind: positive, readBy: WORKER },
  { name: 'CHAIN_OUTCOME_RECONCILE_INTERVAL_MS', kind: positive, readBy: WORKER },
  { name: 'CHAIN_OUTCOME_RECONCILE_AFTER_MS', kind: positive, readBy: WORKER },
  { name: 'CHAIN_OUTCOME_RECONCILE_BATCH_SIZE', kind: positive, readBy: WORKER },
  { name: 'WEBHOOK_DELIVERY_POLL_INTERVAL_MS', kind: positive, readBy: WORKER },
  { name: 'WEBHOOK_DELIVERY_BATCH_SIZE', kind: positive, readBy: WORKER },
  { name: 'INDEXER_POLL_INTERVAL_MS', kind: positive, readBy: WORKER },
  { name: 'INDEXER_PAGE_SIZE', kind: positive, readBy: WORKER },
  { name: 'INDEXER_MAX_PAGES_PER_POLL', kind: positive, readBy: WORKER },
  { name: 'ORG_PROVISION_WORKER_ENABLED', kind: bool, readBy: WORKER },
  { name: 'ORG_PROVISION_POLL_INTERVAL_MS', kind: positive, readBy: WORKER },
  { name: 'BUDGET_WARNING_POLL_INTERVAL_MS', kind: positive, readBy: WORKER },
];

export interface EnvValidation {
  /** Each problem that must stop the process, one line per variable. */
  errors: string[];
  /** Feature secrets left unset: the process boots, and those features answer 503. */
  disabledFeatures: string[];
}

/** The value as the modules will see it: unset and empty both mean "use the default". */
function valueOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function checkKind(name: string, value: string, kind: Kind): string | undefined {
  switch (kind.type) {
    case 'string':
      return undefined;
    case 'url': {
      let protocol: string;
      try {
        protocol = new URL(value).protocol;
      } catch {
        return `${name} must be a URL, got an unparseable value`;
      }
      return kind.protocols.includes(protocol)
        ? undefined
        : `${name} must be a ${kind.protocols.join(' or ')} URL, got "${protocol}"`;
    }
    case 'int': {
      if (!/^\d+$/.test(value) || Number(value) < kind.min) {
        return `${name} must be an integer of at least ${kind.min}, got "${value}"`;
      }
      return undefined;
    }
    case 'bool':
      return value === 'true' || value === 'false' ? undefined : `${name} must be "true" or "false", got "${value}"`;
    case 'enum':
      return kind.values.includes(value)
        ? undefined
        : `${name} must be one of ${kind.values.join(', ')}, got "${value}"`;
    case 'base64Key32':
      // Same rule `OrganizationIdentityCipher` applies; never echo the value, it is a key.
      return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32
        ? undefined
        : `${name} must be a base64-encoded 32-byte key`;
  }
}

/**
 * A worker signer (`infra/clients/sui/signer.ts`'s `loadSigner`) must resolve at boot, not on the
 * first job: a KMS key id (with a region, unless it is an ARN), or off mainnet a raw key.
 */
function checkSigner(
  env: NodeJS.ProcessEnv,
  network: string,
  kmsKeyIdEnv: string,
  privateKeyEnv: string,
  role: string,
): string | undefined {
  const kmsKeyId = valueOf(env, kmsKeyIdEnv);
  if (kmsKeyId) {
    if (!/^arn:aws[\w-]*:kms:[a-z0-9-]+:/.test(kmsKeyId) && !valueOf(env, 'AWS_REGION')) {
      return `AWS_REGION is required for ${kmsKeyIdEnv}: only a key ARN carries its own region`;
    }
    return undefined;
  }
  if (network === 'mainnet') {
    return valueOf(env, privateKeyEnv)
      ? `${privateKeyEnv} is refused on mainnet: set ${kmsKeyIdEnv} to an AWS KMS key for the ${role}`
      : `${kmsKeyIdEnv} is required on mainnet for the ${role}`;
  }
  return valueOf(env, privateKeyEnv)
    ? undefined
    : `The ${role} needs ${kmsKeyIdEnv} (an AWS KMS key) or, off mainnet, ${privateKeyEnv}`;
}

export function validateEnv(process: ProcessKind, env: NodeJS.ProcessEnv): EnvValidation {
  const errors: string[] = [];
  const disabledFeatures: string[] = [];

  for (const spec of ENV_SCHEMA) {
    if (!spec.readBy.includes(process)) continue;
    const value = valueOf(env, spec.name);
    if (value === undefined) {
      if (spec.optionalFeature) disabledFeatures.push(`${spec.optionalFeature} (${spec.name})`);
      continue;
    }
    const error = checkKind(spec.name, value, spec.kind);
    if (error) errors.push(error);
  }

  // Without it postgres.provider.ts falls back to a local database, which a deployed process
  // must never silently use.
  if (!valueOf(env, 'DATABASE_URL')) errors.push('DATABASE_URL is required');

  if (process === 'worker') {
    const network = valueOf(env, 'SUI_NETWORK') ?? 'testnet';
    const issuer = checkSigner(env, network, 'SUI_ISSUER_KMS_KEY_ID', 'SUI_ISSUER_PRIVATE_KEY', 'issuer signer');
    if (issuer) errors.push(issuer);
    if (valueOf(env, 'ORG_PROVISION_WORKER_ENABLED') === 'true') {
      const admin = checkSigner(
        env,
        network,
        'SUI_PROGRAM_ADMIN_KMS_KEY_ID',
        'SUI_PROGRAM_ADMIN_PRIVATE_KEY',
        'program admin signer (ORG_PROVISION_WORKER_ENABLED=true)',
      );
      if (admin) errors.push(admin);
    }
  }

  return { errors, disabledFeatures };
}

export class InvalidEnvironmentError extends Error {
  constructor(process: ProcessKind, errors: string[]) {
    super(`Invalid environment for the ${process} process:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * Throws `InvalidEnvironmentError` listing every problem at once, so one restart fixes them all.
 * Returns the feature secrets left unset, for the caller to log.
 */
export function assertValidEnv(process: ProcessKind, env: NodeJS.ProcessEnv = globalThis.process.env): string[] {
  const { errors, disabledFeatures } = validateEnv(process, env);
  if (errors.length > 0) throw new InvalidEnvironmentError(process, errors);
  return disabledFeatures;
}
