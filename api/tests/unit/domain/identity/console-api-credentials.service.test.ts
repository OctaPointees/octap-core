import { describe, expect, it, vi } from 'vitest';
import { ConsoleApiCredentialsService } from '#domain/identity/console-api-credentials.service.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { ApiCredentialsService, CredentialWriteOptions } from '#infra/auth/api-credentials.service.js';
import type { ApiCredential } from '#infra/db/repositories/api-credentials.repository.js';

const createdAt = new Date('2026-11-11T00:00:00Z');
const row = (scopes: string[]) =>
  ({
    id: 'c1',
    organizationId: 'org',
    name: 'pos',
    keyPrefix: 'octap_live_12345678',
    keyHash: 'secret-hash',
    scopes,
    status: 'ACTIVE',
    createdAt,
    lastUsedAt: null,
  }) as unknown as ApiCredential;

function setup(credentials: Partial<ApiCredentialsService> = {}) {
  let role = 'OWNER';
  const repository = {
    withDeveloperAccess: vi.fn((_u: string, _o: string, action: (tx: unknown, role: string) => unknown) =>
      action('tx', role),
    ),
  };
  const service = new ConsoleApiCredentialsService(
    repository as unknown as ConsoleOrganizationsRepository,
    credentials as ApiCredentialsService,
  );
  return { service, setRole: (next: string) => (role = next) };
}

describe('ConsoleApiCredentialsService', () => {
  it('validates an API key body before persistence, and never issues admin', () => {
    const { service } = setup();
    for (const input of [{}, { name: ' ' }, { name: 'x'.repeat(101) }, { name: 7 }]) {
      expect(() => service.issue('user', 'org', input)).toThrow('name must be 1–100 characters');
    }
    for (const scope of ['admin', 'READ', '', ['read']]) {
      expect(() => service.issue('user', 'org', { name: 'pos', scope })).toThrow('scope must be read or write');
    }
    expect(() => service.issue('user', 'org', { name: 'pos', scopes: ['admin'] })).toThrow(
      'Only name, scope and environment',
    );
    expect(() => service.rename('user', 'org', 'id', { name: 'pos', scope: 'read' })).toThrow('Only the name');
  });

  it('maps scope to the granted scopes and returns only whitelisted fields', async () => {
    const issue = vi.fn(async (_org: string, name: string, scopes: string[]) => ({
      credential: { ...row(scopes), name },
      rawKey: 'octap_live_raw',
    }));
    const { service, setRole } = setup({ issue });

    const read = await service.issue('user', 'org', { name: ' pos ' });
    expect(issue).toHaveBeenLastCalledWith('org', 'pos', ['read'], 'tx', 'LIVE');
    expect(read).toEqual({
      id: 'c1',
      name: 'pos',
      keyPrefix: 'octap_live_12345678',
      scopes: ['read'],
      status: 'ACTIVE',
      createdAt: '2026-11-11T00:00:00.000Z',
      lastUsedAt: null,
      rawKey: 'octap_live_raw',
    });
    await service.issue('user', 'org', { name: 'writer', scope: 'write' });
    expect(issue).toHaveBeenLastCalledWith('org', 'writer', ['read', 'write'], 'tx', 'LIVE');

    // A Business Developer gets read keys only.
    setRole('BUSINESS_DEVELOPER');
    issue.mockClear();
    await expect(service.issue('user', 'org', { name: 'w', scope: 'write' })).rejects.toThrow(
      'Only the Owner can create a live write key',
    );
    expect(issue).not.toHaveBeenCalled();
    await service.issue('user', 'org', { name: 'r' });
    expect(issue).toHaveBeenLastCalledWith('org', 'r', ['read'], 'tx', 'LIVE');
  });

  it('checks the role against the row the write locked, in one lookup', async () => {
    // Stands in for ApiCredentialsService: runs `authorize` on the locked row, then writes.
    const write = (scopes: string[]) =>
      vi.fn(async (...args: unknown[]) => {
        const options = args.at(-1) as CredentialWriteOptions;
        expect(options.tx).toBe('tx');
        options.authorize!(row(scopes));
        return row(scopes);
      });
    const rename = write(['read', 'write']);
    const revoke = write(['read', 'write']);
    const { service, setRole } = setup({ rename, revoke });

    await expect(service.rename('user', 'org', 'c1', { name: 'till' })).resolves.toMatchObject({ id: 'c1' });
    await expect(service.revoke('user', 'org', 'c1')).resolves.toEqual({ revoked: true });

    setRole('BUSINESS_DEVELOPER');
    await expect(service.rename('user', 'org', 'c1', { name: 'till' })).rejects.toThrow('Only the Owner can revoke');
    await expect(service.revoke('user', 'org', 'c1')).rejects.toThrow('Only the Owner can revoke');
    expect(rename).toHaveBeenLastCalledWith('org', 'c1', 'till', expect.objectContaining({ tx: 'tx' }));
  });

  it('lets a Business Developer issue and manage a sandbox write key, never a live one (OCT-297)', async () => {
    const issue = vi.fn(async (_o: string, _n: string, scopes: string[], _tx: unknown, environment: string) => ({
      credential: { ...row(scopes), environment },
      rawKey: 'octap_test_raw',
    }));
    const rename = vi.fn(async (_o: string, _c: string, _n: string, options: CredentialWriteOptions) => {
      options.authorize?.({ ...row(['read', 'write']), environment: 'SANDBOX' } as ApiCredential);
      return { ...row(['read', 'write']), environment: 'SANDBOX' } as ApiCredential;
    });
    const { service, setRole } = setup({ issue, rename } as unknown as Partial<ApiCredentialsService>);
    setRole('BUSINESS_DEVELOPER');

    const created = await service.issue('user', 'org', { name: 'test', scope: 'write', environment: 'SANDBOX' });
    expect(issue).toHaveBeenLastCalledWith('org', 'test', ['read', 'write'], 'tx', 'SANDBOX');
    expect(created).toMatchObject({ environment: 'SANDBOX', rawKey: 'octap_test_raw' });
    await expect(service.rename('user', 'org', 'c1', { name: 'renamed' })).resolves.toMatchObject({
      environment: 'SANDBOX',
    });
    await expect(service.issue('user', 'org', { name: 'x', scope: 'write', environment: 'LIVE' })).rejects.toThrow(
      'Only the Owner can create a live write key',
    );
    expect(() => service.issue('user', 'org', { name: 'x', environment: 'TEST' })).toThrow(
      'environment must be LIVE or SANDBOX',
    );
  });
});
