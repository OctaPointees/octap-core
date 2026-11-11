import { describe, expect, it, vi } from 'vitest';
import { ConsoleOrganizationsService } from '#domain/identity/console-organizations.service.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { ApiCredentialsService } from '#infra/auth/api-credentials.service.js';

const noCredentials = {} as ApiCredentialsService;

describe('ConsoleOrganizationsService', () => {
  it('does not hide unexpected persistence failures as permission errors', async () => {
    const failure = new Error('Database unavailable');
    const repository = { applications: vi.fn().mockRejectedValue(failure) };
    const service = new ConsoleOrganizationsService(
      repository as unknown as ConsoleOrganizationsRepository,
      noCredentials,
    );
    await expect(service.applications('user')).rejects.toBe(failure);
  });
  it('rejects missing/oversized profile fields and invalid invitation inputs before persistence', async () => {
    const repository = {} as ConsoleOrganizationsRepository;
    const service = new ConsoleOrganizationsService(repository, noCredentials);
    for (const input of [{ name: ' ' }, { name: 'x'.repeat(161) }, { name: 'Business', taxId: false }]) {
      expect(() => service.profile('user', 'org', input)).toThrow('Invalid');
    }
    for (const input of [
      { email: 12 },
      { email: 'bad address@example.com' },
      { email: 'x'.repeat(255) + '@example.com' },
    ]) {
      expect(() => service.invite('user', 'org', input)).toThrow('valid email');
    }
  });
  it('validates an API key body before persistence, and never issues admin', async () => {
    const service = new ConsoleOrganizationsService({} as ConsoleOrganizationsRepository, noCredentials);
    for (const input of [{}, { name: ' ' }, { name: 'x'.repeat(101) }, { name: 7 }]) {
      expect(() => service.issueCredential('user', 'org', input)).toThrow('name must be 1–100 characters');
    }
    for (const scope of ['admin', 'READ', '', ['read']]) {
      expect(() => service.issueCredential('user', 'org', { name: 'pos', scope })).toThrow(
        'scope must be read or write',
      );
    }
    expect(() => service.issueCredential('user', 'org', { name: 'pos', scopes: ['admin'] })).toThrow(
      'Only name and scope',
    );
    expect(() => service.renameCredential('user', 'org', 'id', { name: 'pos', scope: 'read' })).toThrow(
      'Only the name',
    );
  });
  it('maps scope to the granted scopes and returns only whitelisted fields', async () => {
    const createdAt = new Date('2026-11-11T00:00:00Z');
    const issue = vi.fn(async (organizationId: string, name: string, scopes: string[]) => ({
      credential: {
        id: 'c1',
        organizationId,
        name,
        keyPrefix: 'octap_live_12345678',
        keyHash: 'secret-hash',
        scopes,
        status: 'ACTIVE' as const,
        createdAt,
        lastUsedAt: null,
      },
      rawKey: 'octap_live_raw',
    }));
    let role = 'OWNER';
    const repository = {
      withStaffAccess: vi.fn((_u: string, _o: string, action: (tx: unknown, role: string) => unknown) =>
        action('tx', role),
      ),
    };
    const service = new ConsoleOrganizationsService(
      repository as unknown as ConsoleOrganizationsRepository,
      { issue } as unknown as ApiCredentialsService,
    );
    const read = await service.issueCredential('user', 'org', { name: ' pos ' });
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
    await service.issueCredential('user', 'org', { name: 'writer', scope: 'write' });
    expect(issue).toHaveBeenLastCalledWith('org', 'writer', ['read', 'write'], 'tx');

    // A Business Developer gets read keys only.
    role = 'BUSINESS_DEVELOPER';
    issue.mockClear();
    await expect(service.issueCredential('user', 'org', { name: 'w', scope: 'write' })).rejects.toThrow(
      'Only the Owner can create a write key',
    );
    expect(issue).not.toHaveBeenCalled();
    await service.issueCredential('user', 'org', { name: 'r' });
    expect(issue).toHaveBeenLastCalledWith('org', 'r', ['read'], 'tx');
  });
});
