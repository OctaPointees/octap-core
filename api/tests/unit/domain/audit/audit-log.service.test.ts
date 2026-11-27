import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '#domain/audit/audit-log.service.js';
import type { AuditQuery, AuditRepository } from '#infra/db/repositories/audit.repository.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { stub } from '../../../helpers/stub.js';

const ORG = 'org-1';

function setup(denied = false) {
  const page = vi.fn<(tx: unknown, org: string, q: AuditQuery, limit: number, cursor?: string) => Promise<unknown>>(
    async () => ({
      rows: [
        {
          id: 'a1',
          sequence: 7,
          organizationId: ORG,
          occurredAt: new Date('2026-11-26T00:00:00Z'),
          actorType: 'USER',
          actorId: 'u1',
          actorLabel: 'Owner One',
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: 'k1',
          requestId: 'r1',
          changes: null,
        },
      ],
      nextCursor: 'a1',
    }),
  );
  const withOwnerAccess = vi.fn(async (_u: string, _o: string, action: (tx: unknown) => Promise<unknown>) => {
    if (denied) throw new ConsoleAccessError();
    return action({});
  });
  return {
    page,
    withOwnerAccess,
    service: new AuditLogService(
      stub<ConsoleOrganizationsRepository>({ withOwnerAccess }),
      stub<AuditRepository>({ page }),
    ),
  };
}

describe('AuditLogService', () => {
  it('reads under the Owner check and maps rows', async () => {
    const { service, withOwnerAccess, page } = setup();
    const cursor = '00000000-0000-4000-8000-000000000009';
    const result = await service.list('u', ORG, { action: 'api_key.', limit: '10', cursor });
    expect(withOwnerAccess).toHaveBeenCalledWith('u', ORG, expect.any(Function));
    expect(page).toHaveBeenCalledWith({}, ORG, { action: 'api_key.' }, 10, cursor);
    expect(result).toEqual({
      items: [
        {
          id: 'a1',
          occurredAt: '2026-11-26T00:00:00.000Z',
          actor: { type: 'USER', id: 'u1', label: 'Owner One' },
          action: 'api_key.revoked',
          target: { type: 'api_key', id: 'k1' },
          requestId: 'r1',
          changes: null,
        },
      ],
      nextCursor: 'a1',
    });
  });

  it('is a 403 for anyone but the active Owner', async () => {
    await expect(setup(true).service.list('u', ORG, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [{ limit: '0' }],
    [{ cursor: 'abc' }],
    [{ cursor: '9' }],
    [{ from: 'Nov 1 2026' }],
    [{ from: '2026-11-01T00:00:00' }],
    [{ actorType: 'ROBOT' }],
    [{ actorId: 'nope' }],
    [{ from: 'yesterday' }],
    [{ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ action: 'x'.repeat(101) }],
    [{ sort: 'asc' }],
  ])('rejects %j with 400 before reading', async (input) => {
    const { service, page } = setup();
    await expect(service.list('u', ORG, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(page).not.toHaveBeenCalled();
  });
});
