import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EvidenceService } from '#domain/audit/evidence.service.js';
import { EvidenceBuilder, periodStartOf } from '#domain/audit/evidence-builder.service.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { EvidencePeriodRow, EvidenceRepository } from '#infra/db/repositories/evidence.repository.js';

const ORG = '0b6c2f1e-1111-4222-8333-444455556666';
const PERIOD = '9a1b2c3d-1111-4222-8333-444455556666';

function row(overrides: Partial<EvidencePeriodRow> = {}): EvidencePeriodRow {
  return {
    id: PERIOD,
    organizationId: ORG,
    periodStart: new Date('2026-11-24T00:00:00.000Z'),
    periodEnd: new Date('2026-11-25T00:00:00.000Z'),
    ledgerCount: 0,
    ledgerHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    auditCount: 0,
    auditHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    previousManifestHash: null,
    manifestHash: 'ab'.repeat(32),
    status: 'SEALED',
    network: 'testnet',
    sealObjectId: '0xseal',
    sealDigest: 'TX',
    sealedAt: new Date('2026-11-25T00:10:00.000Z'),
    archiveStatus: 'ARCHIVED',
    archiveFileId: 'f1',
    walrusBlobId: 'blob-1',
    archivedAt: new Date('2026-11-25T00:12:00.000Z'),
    archiveError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(period: EvidencePeriodRow | null = row(), denied = false) {
  const evidence = {
    page: vi.fn(async () => ({
      rows: period ? [period] : [],
      nextCursor: null,
      sealedThrough: period?.periodEnd ?? null,
      periodCount: period ? 1 : 0,
    })),
    get: vi.fn(async () => period),
    ledgerFacts: vi.fn(async () => []),
    auditFacts: vi.fn(async () => []),
  };
  const organizations = {
    withOwnerAccess: vi.fn(async (_u: string, _o: string, action: (tx: unknown) => Promise<unknown>) => {
      if (denied) throw new ConsoleAccessError('not owner');
      return action({});
    }),
  };
  const builder = new EvidenceBuilder(evidence as unknown as EvidenceRepository);
  const service = new EvidenceService(
    organizations as unknown as ConsoleOrganizationsRepository,
    evidence as unknown as EvidenceRepository,
    builder,
  );
  return { service, evidence };
}

describe('EvidenceService', () => {
  it('lists periods with how far sealing has reached', async () => {
    const { service } = setup();
    await expect(service.list('u', ORG, {})).resolves.toMatchObject({
      sealedThrough: '2026-11-25T00:00:00.000Z',
      periodCount: 1,
      items: [{ id: PERIOD, status: 'SEALED', archiveStatus: 'ARCHIVED', ledgerCount: 0 }],
      nextCursor: null,
    });
    await expect(setup(null).service.list('u', ORG, {})).resolves.toMatchObject({ sealedThrough: null, items: [] });
  });

  it('validates the query', async () => {
    const { service, evidence } = setup();
    await expect(service.list('u', ORG, { from: 'x' })).rejects.toThrow(/Unsupported query fields: from/);
    await expect(service.list('u', ORG, { limit: '0' })).rejects.toThrow(BadRequestException);
    await expect(service.list('u', ORG, { cursor: 'nope' })).rejects.toThrow(/Invalid cursor/);
    evidence.page.mockResolvedValueOnce(null as never);
    await expect(service.list('u', ORG, { cursor: PERIOD, limit: '5' })).rejects.toThrow(/Invalid cursor/);
  });

  it('is the active Owner’s alone', async () => {
    await expect(setup(row(), true).service.detail('u', ORG, PERIOD)).rejects.toThrow(ForbiddenException);
  });

  it('shows a period with its seal and its copy', async () => {
    await expect(setup().service.detail('u', ORG, PERIOD)).resolves.toMatchObject({
      manifestHash: 'ab'.repeat(32),
      seal: {
        network: 'testnet',
        sealObjectId: '0xseal',
        transactionDigest: 'TX',
        sealedAt: '2026-11-25T00:10:00.000Z',
      },
      archive: { status: 'ARCHIVED', walrusBlobId: 'blob-1', archivedAt: '2026-11-25T00:12:00.000Z' },
    });
    await expect(
      setup(row({ status: 'SEALING', sealObjectId: null, sealedAt: null, archivedAt: null })).service.detail(
        'u',
        ORG,
        PERIOD,
      ),
    ).resolves.toMatchObject({ seal: null, archive: { archivedAt: null } });
    await expect(setup(null).service.detail('u', ORG, PERIOD)).rejects.toThrow(NotFoundException);
  });

  it('gives a bundle only once a period is sealed', async () => {
    await expect(setup().service.bundle('u', ORG, PERIOD)).resolves.toMatchObject({
      format: 'octap.evidence/v1',
      manifestHash: 'ab'.repeat(32),
      ledger: [],
      audit: [],
    });
    await expect(
      setup(row({ status: 'SEALING', sealObjectId: null, sealedAt: null })).service.bundle('u', ORG, PERIOD),
    ).rejects.toThrow(ConflictException);
  });

  it('recomputes a period next to the manifest as sealed', async () => {
    const result = await setup().service.recompute('u', ORG, PERIOD);
    expect(result.sealedManifest.ledger.sha256).toBe(result.recomputedManifest.ledger.sha256);
    expect(result.seal?.sealObjectId).toBe('0xseal');
  });
});

describe('EvidenceBuilder', () => {
  it('aligns periods to the epoch, so a day is a UTC day', () => {
    expect(periodStartOf(new Date('2026-11-24T17:30:00.000Z'), 86_400_000).toISOString()).toBe(
      '2026-11-24T00:00:00.000Z',
    );
    vi.stubEnv('EVIDENCE_PERIOD_MS', '300000');
    expect(periodStartOf(new Date('2026-11-24T17:33:20.000Z')).toISOString()).toBe('2026-11-24T17:30:00.000Z');
  });

  it('names no package for a network it does not know, and refuses a bundle of an unsealed period', async () => {
    const builder = new EvidenceBuilder({} as EvidenceRepository);
    expect(builder.sealReference(row({ network: 'devnet', sealDigest: null }))).toMatchObject({
      packageId: '',
      transactionDigest: '',
    });
    await expect(builder.bundle({} as never, row({ status: 'SEALING' }))).rejects.toThrow(/not sealed yet/);
  });
});
