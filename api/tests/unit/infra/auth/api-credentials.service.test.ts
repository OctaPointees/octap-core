import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  API_CREDENTIAL_LIMIT_REACHED,
  ApiCredentialsService,
  DEFAULT_SCOPES,
  MAX_ACTIVE_API_CREDENTIALS,
} from '#infra/auth/api-credentials.service.js';
import { hashApiKey } from '#infra/auth/api-key-hash.util.js';
import type { ApiCredentialsRepository } from '#infra/db/repositories/api-credentials.repository.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { stub } from '../../../helpers/stub.js';

type Row = {
  id: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  status: string;
};

const TX = { tx: true } as unknown as DrizzleDb;

function inMemoryRepo() {
  const store = new Map<string, Row>();
  let nextId = 1;
  const revoke = vi.fn(async (_tx: DrizzleDb, id: string) => Object.assign(store.get(id)!, { status: 'REVOKED' }));
  const createWithinLimit = vi.fn(async (data: Omit<Row, 'id' | 'status'>, limit: number) => {
    const active = [...store.values()].filter((r) => r.organizationId === data.organizationId && r.status === 'ACTIVE');
    if (active.length >= limit) return undefined;
    const row = { id: `cred-${nextId++}`, status: 'ACTIVE', ...data };
    store.set(row.id, row);
    return row;
  });
  const inTransaction = vi.fn(async (tx: DrizzleDb | undefined, work: (tx: DrizzleDb) => Promise<unknown>) =>
    work(tx ?? ({ own: true } as unknown as DrizzleDb)),
  );
  const repo = stub<ApiCredentialsRepository>({
    createWithinLimit,
    findForUpdate: async (_tx: DrizzleDb, id: string) => store.get(id),
    revoke,
    rename: async (_tx: DrizzleDb, id: string, name: string) => Object.assign(store.get(id)!, { name }),
    inTransaction,
  });
  return { store, repo, revoke, createWithinLimit, inTransaction };
}

describe('ApiCredentialsService', () => {
  it('issues a key whose raw value is never persisted, only its hash and display prefix', async () => {
    const { repo } = inMemoryRepo();
    const { credential, rawKey } = await new ApiCredentialsService(repo).issue('org-1', 'pos-terminal-1');

    expect(rawKey).toMatch(/^octap_live_[0-9a-f]{48}$/);
    expect(credential.keyHash).toBe(hashApiKey(rawKey));
    expect(credential.keyPrefix).toBe(rawKey.slice(0, 'octap_live_'.length + 8));
    expect(JSON.stringify(credential)).not.toContain(rawKey);
    expect(credential.scopes).toEqual(DEFAULT_SCOPES);
  });

  it('passes the caller transaction and the active-key limit to the repository', async () => {
    const { repo, createWithinLimit } = inMemoryRepo();
    await new ApiCredentialsService(repo).issue('org-1', 'k', ['read'], TX);
    expect(createWithinLimit).toHaveBeenCalledWith(expect.anything(), MAX_ACTIVE_API_CREDENTIALS, TX);
  });

  it('refuses the 26th ACTIVE key with a 409 and its own error code, and allows one again after a revoke', async () => {
    const { repo } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    const issued = [];
    for (let i = 0; i < MAX_ACTIVE_API_CREDENTIALS; i += 1) issued.push(await service.issue('org-1', `k${i}`));

    const refused = await service.issue('org-1', 'one too many').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: API_CREDENTIAL_LIMIT_REACHED,
    });
    // Another organization has its own limit.
    await expect(service.issue('org-2', 'k')).resolves.toBeDefined();

    await service.revoke('org-1', issued[0].credential.id);
    await expect(service.issue('org-1', 'after revoke')).resolves.toBeDefined();
  });

  it('fails closed across tenants on revoke and rename', async () => {
    const { repo } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    const { credential } = await service.issue('org-1', 'pos-terminal-1', ['read']);

    await expect(service.revoke('org-OTHER', credential.id)).rejects.toThrow(/not found/);
    await expect(service.rename('org-OTHER', credential.id, 'x')).rejects.toThrow(/not found/);
    await expect(service.revoke('org-1', 'cred-missing')).rejects.toThrow(/not found/);

    expect((await service.rename('org-1', credential.id, 'till 2')).name).toBe('till 2');
  });

  it('revoking an already-revoked credential is idempotent and writes nothing; a revoked key cannot be renamed', async () => {
    const { repo, revoke, inTransaction } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    const { credential } = await service.issue('org-1', 'k');

    await service.revoke('org-1', credential.id, TX);
    const again = await service.revoke('org-1', credential.id);

    expect(again.status).toBe('REVOKED');
    expect(revoke).toHaveBeenCalledOnce();
    expect(inTransaction).toHaveBeenCalledWith(TX, expect.any(Function));
    await expect(service.rename('org-1', credential.id, 'x')).rejects.toThrow(/not found/);
  });
});
