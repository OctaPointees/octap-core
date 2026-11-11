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
    expect(() => service.issue('user', 'org', { name: 'pos', scopes: ['admin'] })).toThrow('Only name and scope');
    expect(() => service.rename('user', 'org', 'id', { name: 'pos', scope: 'read' })).toThrow('Only the name');
  });

  it('maps scope to the granted scopes and returns only whitelisted fields', async () => {
    const issue = vi.fn(async (_org: string, name: string, scopes: string[]) => ({
      credential: { ...row(scopes), name },
      rawKey: 'octap_live_raw',
    }));
    const { service, setRole } = setup({ issue });

    const read = await service.issue('user', 'org', { name: ' pos ' });
    expect(issue).toHaveBeenLastCalledWith('org', 'pos', ['read'], 'tx');
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
    expect(issue).toHaveBeenLastCalledWith('org', 'writer', ['read', 'write'], 'tx');

    // A Business Developer gets read keys only.
    setRole('BUSINESS_DEVELOPER');
    issue.mockClear();
    await expect(service.issue('user', 'org', { name: 'w', scope: 'write' })).rejects.toThrow(
      'Only the Owner can create a write key',
    );
    expect(issue).not.toHaveBeenCalled();
    await service.issue('user', 'org', { name: 'r' });
    expect(issue).toHaveBeenLastCalledWith('org', 'r', ['read'], 'tx');
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
});
