import { describe, expect, it, vi } from 'vitest';
import { ConsoleOrganizationsService } from '#domain/identity/console-organizations.service.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';

describe('ConsoleOrganizationsService', () => {
  it('does not hide unexpected persistence failures as permission errors', async () => {
    const failure = new Error('Database unavailable');
    const repository = { applications: vi.fn().mockRejectedValue(failure) };
    const service = new ConsoleOrganizationsService(repository as unknown as ConsoleOrganizationsRepository);
    await expect(service.applications('user')).rejects.toBe(failure);
  });
  it('rejects missing/oversized profile fields and invalid invitation inputs before persistence', async () => {
    const repository = {} as ConsoleOrganizationsRepository;
    const service = new ConsoleOrganizationsService(repository);
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
});
