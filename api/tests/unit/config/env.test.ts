import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA, InvalidEnvironmentError, assertValidEnv, validateEnv } from '#config/env.js';

const DB = { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/octap_dev' };
const KEY_32 = Buffer.alloc(32, 7).toString('base64');

describe('validateEnv', () => {
  it('accepts a minimal API environment and lists the unset feature secrets', () => {
    expect(validateEnv('api', DB)).toEqual({
      errors: [],
      disabledFeatures: [
        'zkLogin and sponsored transactions (ENOKI_API_KEY)',
        'console Google sign-in (CONSOLE_GOOGLE_CLIENT_ID)',
        'CCCD storage (ORGANIZATION_IDENTITY_ENCRYPTION_KEY)',
        'MCP sign-in (MCP_OAUTH_ISSUER_URL)',
        'MCP sign-in (MCP_OAUTH_SIGNING_KEY)',
        'dashboard assistant (OCTAP_MCP_PUBLIC_URL)',
        'dashboard assistant (OPENAI_API_KEY)',
        'dashboard assistant (OPENAI_MODEL)',
      ],
    });
  });

  it('requires DATABASE_URL in both processes, treating an empty value as unset', () => {
    expect(validateEnv('api', {}).errors).toEqual(['DATABASE_URL is required']);
    expect(validateEnv('worker', { DATABASE_URL: '', SUI_ISSUER_PRIVATE_KEY: 'k' }).errors).toEqual([
      'DATABASE_URL is required',
    ]);
  });

  it('reports every malformed value at once, without echoing a key', () => {
    const { errors } = validateEnv('api', {
      DATABASE_URL: 'mysql://db',
      REDIS_URL: 'not a url',
      API_PORT: '30x0',
      RATE_LIMIT_MAX_REQUESTS: '0',
      OPENAPI_ENABLED: 'yes',
      SUI_NETWORK: 'devnet',
      ORGANIZATION_IDENTITY_ENCRYPTION_KEY: 'c2hvcnQ=',
    });
    expect(errors).toEqual([
      'API_PORT must be an integer from 0 to 65535, got "30x0"',
      'RATE_LIMIT_MAX_REQUESTS must be an integer of at least 1, got "0"',
      'OPENAPI_ENABLED must be "true" or "false", got "yes"',
      'DATABASE_URL must be a postgres: or postgresql: URL, got "mysql:"',
      'REDIS_URL must be a URL, got an unparseable value',
      'SUI_NETWORK must be one of testnet, mainnet, got "devnet"',
      'ORGANIZATION_IDENTITY_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
    ]);
    expect(errors.join()).not.toContain('c2hvcnQ');
  });

  it('rejects a number, flag, enum or URL the modules would read differently: empty or padded', () => {
    expect(
      validateEnv('worker', {
        ...DB,
        SUI_ISSUER_PRIVATE_KEY: 'k',
        SUI_NETWORK: ' mainnet',
        ORG_PROVISION_WORKER_ENABLED: 'true ',
        CHAIN_SUBMIT_BATCH_SIZE: '',
      }).errors,
    ).toEqual([
      'SUI_NETWORK has leading or trailing whitespace, which the code would read as-is',
      'CHAIN_SUBMIT_BATCH_SIZE is set but empty: remove it to use the default',
      'ORG_PROVISION_WORKER_ENABLED has leading or trailing whitespace, which the code would read as-is',
    ]);
  });

  it('requires the program admin signer only for the exact value provisioning.worker.ts runs on', () => {
    // 'true ' is already an error above; with it, provisioning stays off, so no admin signer is demanded.
    const { errors } = validateEnv('worker', {
      ...DB,
      SUI_ISSUER_PRIVATE_KEY: 'k',
      ORG_PROVISION_WORKER_ENABLED: 'true ',
    });
    expect(errors.some((e) => e.includes('program admin signer'))).toBe(false);
  });

  it('treats a blank text value as unset, the way its readers do', () => {
    expect(validateEnv('api', { ...DB, ENOKI_API_KEY: '  ' }).disabledFeatures).toContain(
      'zkLogin and sponsored transactions (ENOKI_API_KEY)',
    );
    expect(validateEnv('api', { DATABASE_URL: '' }).errors).toEqual(['DATABASE_URL is required']);
  });

  it('bounds API_PORT to a real port', () => {
    expect(validateEnv('api', { ...DB, API_PORT: '65536' }).errors).toEqual([
      'API_PORT must be an integer from 0 to 65535, got "65536"',
    ]);
    expect(validateEnv('api', { ...DB, API_PORT: '65535' }).errors).toEqual([]);
  });

  it('accepts well-formed values, including a 32-byte identity key', () => {
    expect(
      validateEnv('api', {
        ...DB,
        REDIS_URL: 'rediss://cache:6380',
        API_PORT: '0',
        TRUSTED_PROXY_HOPS: '2',
        OPENAPI_ENABLED: 'false',
        SUI_NETWORK: 'mainnet',
        ENOKI_API_KEY: 'enoki',
        CONSOLE_GOOGLE_CLIENT_ID: 'google',
        ORGANIZATION_IDENTITY_ENCRYPTION_KEY: KEY_32,
        MCP_OAUTH_ISSUER_URL: 'https://api.octap.example',
        MCP_OAUTH_SIGNING_KEY: KEY_32,
        OCTAP_MCP_PUBLIC_URL: 'https://mcp.octap.example',
        ASSISTANT_RATE_LIMIT_PER_MINUTE: '5',
        OPENAI_API_KEY: 'sk-openai-test',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toEqual({ errors: [], disabledFeatures: [] });
  });

  it('checks a variable only for the process that reads it', () => {
    expect(validateEnv('api', { ...DB, CHAIN_SUBMIT_BATCH_SIZE: 'many' }).errors).toEqual([]);
    expect(validateEnv('worker', { ...DB, SUI_ISSUER_PRIVATE_KEY: 'k', API_PORT: 'x' }).errors).toEqual([]);
    expect(
      validateEnv('worker', { ...DB, SUI_ISSUER_PRIVATE_KEY: 'k', CHAIN_SUBMIT_BATCH_SIZE: 'many' }).errors,
    ).toEqual(['CHAIN_SUBMIT_BATCH_SIZE must be an integer of at least 1, got "many"']);
  });

  describe('worker signers', () => {
    it('needs an issuer signer: a KMS key, or off mainnet a raw key', () => {
      expect(validateEnv('worker', DB).errors).toEqual([
        'The issuer signer needs SUI_ISSUER_KMS_KEY_ID (an AWS KMS key) or, off mainnet, SUI_ISSUER_PRIVATE_KEY',
      ]);
      expect(validateEnv('worker', { ...DB, SUI_ISSUER_PRIVATE_KEY: 'suiprivkey1x' }).errors).toEqual([]);
    });

    it('refuses a raw key on mainnet and requires a KMS key there', () => {
      expect(validateEnv('worker', { ...DB, SUI_NETWORK: 'mainnet', SUI_ISSUER_PRIVATE_KEY: 'k' }).errors).toEqual([
        'SUI_ISSUER_PRIVATE_KEY is refused on mainnet: set SUI_ISSUER_KMS_KEY_ID to an AWS KMS key for the issuer signer',
      ]);
      expect(validateEnv('worker', { ...DB, SUI_NETWORK: 'mainnet' }).errors).toEqual([
        'SUI_ISSUER_KMS_KEY_ID is required on mainnet for the issuer signer',
      ]);
    });

    it('needs AWS_REGION for a KMS alias or key id, not for a key ARN', () => {
      expect(validateEnv('worker', { ...DB, SUI_ISSUER_KMS_KEY_ID: 'alias/issuer' }).errors).toEqual([
        'AWS_REGION is required for SUI_ISSUER_KMS_KEY_ID: only a key ARN carries its own region',
      ]);
      expect(
        validateEnv('worker', { ...DB, SUI_ISSUER_KMS_KEY_ID: 'alias/issuer', AWS_REGION: 'ap-southeast-2' }).errors,
      ).toEqual([]);
      expect(
        validateEnv('worker', {
          ...DB,
          SUI_NETWORK: 'mainnet',
          SUI_ISSUER_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:111122223333:key/abc',
        }).errors,
      ).toEqual([]);
    });

    it('needs the program admin signer only when provisioning is enabled', () => {
      const worker = { ...DB, SUI_ISSUER_PRIVATE_KEY: 'k' };
      expect(validateEnv('worker', { ...worker, ORG_PROVISION_WORKER_ENABLED: 'false' }).errors).toEqual([]);
      expect(validateEnv('worker', { ...worker, ORG_PROVISION_WORKER_ENABLED: 'true' }).errors).toEqual([
        'The program admin signer (ORG_PROVISION_WORKER_ENABLED=true) needs SUI_PROGRAM_ADMIN_KMS_KEY_ID (an AWS KMS key) or, off mainnet, SUI_PROGRAM_ADMIN_PRIVATE_KEY',
      ]);
      expect(
        validateEnv('worker', { ...worker, ORG_PROVISION_WORKER_ENABLED: 'true', SUI_PROGRAM_ADMIN_PRIVATE_KEY: 'a' })
          .errors,
      ).toEqual([]);
    });
  });
});

describe('assertValidEnv', () => {
  it('throws one error listing every problem', () => {
    expect(() => assertValidEnv('worker', { API_PORT: 'ignored' })).toThrow(InvalidEnvironmentError);
    expect(() => assertValidEnv('worker', {})).toThrow(
      'Invalid environment for the worker process:\n  - DATABASE_URL is required\n  - The issuer signer needs',
    );
  });

  it('returns the disabled features when the environment is valid', () => {
    expect(assertValidEnv('api', { ...DB, ENOKI_API_KEY: 'e', CONSOLE_GOOGLE_CLIENT_ID: 'g' })).toEqual([
      'CCCD storage (ORGANIZATION_IDENTITY_ENCRYPTION_KEY)',
      'MCP sign-in (MCP_OAUTH_ISSUER_URL)',
      'MCP sign-in (MCP_OAUTH_SIGNING_KEY)',
      'dashboard assistant (OCTAP_MCP_PUBLIC_URL)',
      'dashboard assistant (OPENAI_API_KEY)',
      'dashboard assistant (OPENAI_MODEL)',
    ]);
  });
});

describe('ENV_SCHEMA and .env.example', () => {
  const example = readFileSync(fileURLToPath(new URL('../../../../.env.example', import.meta.url)), 'utf8');
  const names = ENV_SCHEMA.map((spec) => spec.name);

  it('lists each variable once', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('documents every schema variable in .env.example', () => {
    expect(names.filter((name) => !new RegExp(`(^|[\\s#])${name}=`, 'm').test(example))).toEqual([]);
  });

  it('validates every variable .env.example sets', () => {
    const assigned = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(assigned.filter((name) => !names.includes(name))).toEqual([]);
  });
});
