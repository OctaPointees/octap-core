import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerFact } from '@octap/contracts';
import { EvidenceSealProcessor } from '#domain/audit/evidence-seal.processor.js';
import { EvidenceBuilder } from '#domain/audit/evidence-builder.service.js';
import type { EvidencePeriodRow, EvidenceRepository } from '#infra/db/repositories/evidence.repository.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';
import type { WalrusConsoleClient } from '#infra/clients/walrus/walrus-console.client.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';

const ORG = '0b6c2f1e-1111-4222-8333-444455556666';
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

const fact = (confirmedAt: Date): EvidenceLedgerFact => ({
  id: crypto.randomUUID(),
  type: 'EARN',
  pointsAmount: 10,
  purchaseAmount: 1000,
  memberId: crypto.randomUUID(),
  receiptReference: null,
  reversesTransactionId: null,
  digest: `Dg-${confirmedAt.getTime()}`,
  confirmedAt: confirmedAt.toISOString(),
});

/** An in-memory stand-in for the evidence tables and the facts they seal. */
function fakeRepository(activity: Date[]) {
  const periods: EvidencePeriodRow[] = [];
  const repo = {
    periods,
    organizationIds: vi.fn(async () => [ORG]),
    latest: vi.fn(async () => periods.at(-1) ?? null),
    firstActivityFrom: vi.fn(async (_org: string, from: Date) => {
      const next = activity.filter((at) => at >= from).sort((a, b) => a.getTime() - b.getTime())[0];
      return next ?? null;
    }),
    ledgerFacts: vi.fn(async (_db: unknown, _org: string, start: Date, end: Date) =>
      activity.filter((at) => at >= start && at < end).map(fact),
    ),
    auditFacts: vi.fn(async () => []),
    insert: vi.fn(async (row: Partial<EvidencePeriodRow>) => {
      const full = {
        ...row,
        id: crypto.randomUUID(),
        status: 'SEALING',
        sealObjectId: null,
        sealDigest: null,
        sealedAt: null,
        archiveFileId: null,
        walrusBlobId: null,
        archivedAt: null,
        archiveError: null,
      } as EvidencePeriodRow;
      periods.push(full);
      return full;
    }),
    markSealed: vi.fn(async (id: string, seal: { sealObjectId: string; sealDigest: string | null; sealedAt: Date }) => {
      Object.assign(
        periods.find((p) => p.id === id)!,
        seal,
        { status: 'SEALED' },
      );
    }),
    pendingArchives: vi.fn(async () => periods.filter((p) => p.archiveStatus === 'PENDING' && p.status === 'SEALED')),
    updateArchive: vi.fn(async (id: string, patch: Partial<EvidencePeriodRow>) => {
      Object.assign(
        periods.find((p) => p.id === id)!,
        patch,
      );
    }),
  };
  return repo;
}

function fakeSui() {
  let latest: { manifestHash: string; periodStartMs: number } | null = null;
  return {
    evidenceNetwork: 'testnet',
    latestEvidenceSeal: vi.fn(async () =>
      latest
        ? {
            sealObjectId: '0xseal',
            organizationId: ORG,
            periodEndMs: 0,
            previousManifestHash: null,
            sealedAtMs: 0,
            transactionDigest: 'Tx',
            ...latest,
          }
        : null,
    ),
    sealEvidence: vi.fn(async (params: { manifestHash: string; periodStartMs: number }) => {
      latest = { manifestHash: params.manifestHash, periodStartMs: params.periodStartMs };
      return {
        digest: `Tx-${params.periodStartMs}`,
        eventField: (_e: string, field: string) =>
          field === 'seal_id' ? `0xseal-${params.periodStartMs}` : String(params.periodStartMs + DAY + 1),
      };
    }),
  };
}

function setup(activity: Date[], walrus = { enabled: false }) {
  const repo = fakeRepository(activity);
  const sui = fakeSui();
  const builder = new EvidenceBuilder(repo as unknown as EvidenceRepository);
  const processor = new EvidenceSealProcessor(
    {} as DrizzleDb,
    repo as unknown as EvidenceRepository,
    builder,
    sui as unknown as SuiClientService,
    walrus as unknown as WalrusConsoleClient,
  );
  return { repo, sui, processor };
}

describe('EvidenceSealProcessor', () => {
  beforeEach(() => {
    vi.stubEnv('EVIDENCE_PERIOD_MS', String(DAY));
    vi.stubEnv('EVIDENCE_SEAL_DELAY_MS', '600000');
  });

  it('seals every finished day from the first activity on, contiguously, empty days included', async () => {
    const { repo, sui, processor } = setup([
      new Date(day(20).getTime() + 3600_000),
      new Date(day(20).getTime() + 7200_000),
      new Date(day(23).getTime() + 60_000),
    ]);
    const result = await processor.runOnce(new Date(day(24).getTime() + 3600_000));
    expect(result.sealed).toBe(4);
    expect(repo.periods.map((p) => [p.periodStart, p.ledgerCount, p.status, p.archiveStatus])).toEqual([
      [day(20), 2, 'SEALED', 'DISABLED'],
      [day(21), 0, 'SEALED', 'SKIPPED'],
      [day(22), 0, 'SEALED', 'SKIPPED'],
      [day(23), 1, 'SEALED', 'DISABLED'],
    ]);
    expect(repo.periods[0].previousManifestHash).toBeNull();
    for (let i = 1; i < 4; i++) {
      expect(repo.periods[i].periodStart).toEqual(repo.periods[i - 1].periodEnd);
      expect(repo.periods[i].previousManifestHash).toBe(repo.periods[i - 1].manifestHash);
    }
    expect(sui.sealEvidence).toHaveBeenCalledTimes(4);
  });

  it('seals nothing for an organization that never had activity', async () => {
    const { repo, processor } = setup([]);
    await processor.runOnce(day(24));
    expect(repo.periods).toHaveLength(0);
  });

  it('leaves a day until its delay has passed', async () => {
    const { repo, processor } = setup([new Date(day(20).getTime() + 3600_000)]);
    await processor.runOnce(new Date(day(21).getTime() + 60_000));
    expect(repo.periods).toHaveLength(0);
    await processor.runOnce(new Date(day(21).getTime() + 600_000));
    expect(repo.periods).toHaveLength(1);
  });

  it('records a seal that already landed instead of sending it again', async () => {
    const { repo, sui, processor } = setup([new Date(day(20).getTime() + 1)]);
    sui.sealEvidence.mockImplementationOnce(async (params) => {
      // The seal reaches the chain, but the answer is lost.
      await sui.sealEvidence.getMockImplementation()!(params);
      throw new Error('connection reset');
    });
    await processor.runOnce(day(22));
    expect(repo.periods[0].status).toBe('SEALING');
    await processor.runOnce(day(22));
    expect(repo.periods[0]).toMatchObject({ status: 'SEALED', sealObjectId: '0xseal' });
    // Sent once: the second run found it on-chain.
    expect(sui.sealEvidence).toHaveBeenCalledTimes(1);
  });

  it('holds later days while an earlier one cannot be sealed', async () => {
    const { repo, sui, processor } = setup([new Date(day(20).getTime() + 1), new Date(day(21).getTime() + 1)]);
    sui.sealEvidence.mockRejectedValue(new Error('no gas'));
    await processor.runOnce(day(23));
    expect(repo.periods).toHaveLength(1);
    expect(repo.periods[0].status).toBe('SEALING');
  });

  it('uploads a sealed bundle, then records its blob once Walrus has it', async () => {
    const walrus = {
      enabled: true,
      upload: vi.fn(async () => 'file-1'),
      fileState: vi.fn(async () => ({ state: 'completed' as const, blobId: 'blob-1' })),
    };
    const { repo, processor } = setup([new Date(day(20).getTime() + 1)], walrus);
    await processor.runOnce(day(22));
    expect(walrus.upload).toHaveBeenCalledTimes(1);
    const [name, body] = walrus.upload.mock.calls[0] as unknown as [string, Uint8Array];
    expect(name).toContain(ORG);
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ format: 'octap.evidence/v1' });
    expect(repo.periods[0]).toMatchObject({ archiveStatus: 'PENDING', archiveFileId: 'file-1' });
    await processor.archivePending();
    expect(repo.periods[0]).toMatchObject({ archiveStatus: 'ARCHIVED', walrusBlobId: 'blob-1' });
  });

  it('keeps a period SEALING when the seal transaction emitted no seal event', async () => {
    const { repo, sui, processor } = setup([new Date(day(20).getTime() + 1)]);
    sui.sealEvidence.mockResolvedValueOnce({ digest: 'Tx', eventField: () => undefined } as never);
    await processor.runOnce(day(22));
    expect(repo.periods[0].status).toBe('SEALING');
  });

  it('retries an upload Walrus failed, records upload errors, and waits while it is still uploading', async () => {
    const walrus = {
      enabled: true,
      upload: vi.fn(async () => 'file-1'),
      fileState: vi.fn(async (): Promise<{ state: string; error?: string }> => ({ state: 'uploading' })),
    };
    const { repo, processor } = setup([new Date(day(20).getTime() + 1)], walrus);
    await processor.runOnce(day(22));
    await processor.archivePending();
    expect(repo.periods[0]).toMatchObject({ archiveStatus: 'PENDING', archiveFileId: 'file-1' });

    walrus.fileState.mockResolvedValueOnce({ state: 'failed', error: 'walrus: down' });
    await processor.archivePending();
    expect(repo.periods[0]).toMatchObject({ archiveFileId: null, archiveError: 'walrus: down' });

    walrus.upload.mockRejectedValueOnce(new Error('policy missing'));
    await processor.archivePending();
    expect(repo.periods[0]).toMatchObject({ archiveStatus: 'PENDING', archiveError: 'policy missing' });
  });

  it('marks pending copies DISABLED once the archive is switched off', async () => {
    const walrus = { enabled: true, upload: vi.fn(async () => 'f'), fileState: vi.fn() };
    const { repo, processor } = setup([new Date(day(20).getTime() + 1)], walrus);
    walrus.enabled = false;
    await processor.sealOrganization(ORG, day(22));
    repo.periods[0].archiveStatus = 'PENDING';
    await processor.archivePending();
    expect(repo.periods[0].archiveStatus).toBe('DISABLED');
    expect(walrus.upload).not.toHaveBeenCalled();
  });
});
