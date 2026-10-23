import { describe, expect, it, vi } from 'vitest';
import { ApiCredentialsService, DEFAULT_SCOPES } from '../../../../src/infra/auth/api-credentials.service.js';
import { hashApiKey } from '../../../../src/infra/auth/api-key-hash.util.js';
import type { ApiCredentialsRepository } from '../../../../src/infra/db/repositories/api-credentials.repository.js';
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

function inMemoryRepo() {
  const store = new Map<string, Row>();
  let nextId = 1;
  const revoke = vi.fn(async (id: string) => Object.assign(store.get(id)!, { status: 'REVOKED' }));
  const repo = stub<ApiCredentialsRepository>({
    create: async (data: Omit<Row, 'id' | 'status'>) => {
      const row = { id: `cred-${nextId++}`, status: 'ACTIVE', ...data };
      store.set(row.id, row);
      return row;
    },
    findById: async (id: string) => store.get(id),
    listByOrganization: async (orgId: string) => [...store.values()].filter((r) => r.organizationId === orgId),
    revoke,
  });
  return { store, repo, revoke };
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

  it('issues with explicit scopes and lists by organization', async () => {
    const { repo } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    await service.issue('org-1', 'admin', ['admin']);
    await service.issue('org-2', 'other');

    const listed = await service.list('org-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].scopes).toEqual(['admin']);
  });

  it('revoke/rotate lifecycle, failing closed across tenants', async () => {
    const { repo, store } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    const { credential, rawKey } = await service.issue('org-1', 'pos-terminal-1', ['read']);

    // Cross-tenant revoke must fail closed, not silently no-op.
    await expect(service.revoke('org-OTHER', credential.id)).rejects.toThrow(/not found/);
    await expect(service.rotate('org-OTHER', credential.id)).rejects.toThrow(/not found/);
    await expect(service.revoke('org-1', 'cred-missing')).rejects.toThrow(/not found/);

    expect((await service.revoke('org-1', credential.id)).status).toBe('REVOKED');

    const { credential: rotated, rawKey: rotatedKey } = await service.rotate('org-1', credential.id);
    expect(rotatedKey).not.toBe(rawKey);
    expect(store.get(credential.id)?.status).toBe('REVOKED');
    expect(rotated).toMatchObject({ status: 'ACTIVE', name: 'pos-terminal-1', scopes: ['read'] });
  });

  it('revoking an already-revoked credential is idempotent and writes nothing', async () => {
    const { repo, revoke } = inMemoryRepo();
    const service = new ApiCredentialsService(repo);
    const { credential } = await service.issue('org-1', 'k');

    await service.revoke('org-1', credential.id);
    const again = await service.revoke('org-1', credential.id);

    expect(again.status).toBe('REVOKED');
    expect(revoke).toHaveBeenCalledOnce();
  });
});
