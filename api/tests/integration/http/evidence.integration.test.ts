import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { EvidenceBundle, EvidenceRecomputation } from '@octap/contracts';
import { verifyBundle, verifyRecomputation, type OnChainSeal, type SealReader } from '@octap/verify';
import { EvidenceBuilder } from '#domain/audit/evidence-builder.service.js';
import { EvidenceRepository } from '#infra/db/repositories/evidence.repository.js';
import { createTestApp } from '../support/app.js';
import { resetDb, schema, seedMember, seedOrganization } from '../support/db.js';

const ACTORS = ['owner', 'developer'] as const;
type Actor = (typeof ACTORS)[number];
const DAY_START = new Date('2026-11-20T00:00:00.000Z');
const DAY_END = new Date('2026-11-21T00:00:00.000Z');

describe('audit evidence: sealed periods, bundles and checks, Owner only (OCT-77)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let earnId: string;
  let periodId: string;
  let seal: OnChainSeal;
  const reader: SealReader = { readSeal: async () => seal };
  const google = {
    verify: async (token: string) => {
      if (!(ACTORS as readonly string[]).includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: `${token} name`,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const path = (p: string) => `/v1/console/organizations/${orgId}/evidence${p}`;

  /** Seals the day as the worker would, with the chain stood in by `seal`. */
  async function sealDay(): Promise<string> {
    const builder = ctx.app.get(EvidenceBuilder);
    const repo = ctx.app.get(EvidenceRepository);
    const built = await builder.build(ctx.db, orgId, DAY_START, DAY_END, null);
    const row = await repo.insert({
      organizationId: orgId,
      periodStart: DAY_START,
      periodEnd: DAY_END,
      ledgerCount: built.manifest.ledger.count,
      ledgerHash: built.manifest.ledger.sha256,
      auditCount: built.manifest.audit.count,
      auditHash: built.manifest.audit.sha256,
      previousManifestHash: null,
      manifestHash: built.manifestHash,
      network: 'testnet',
      archiveStatus: 'DISABLED',
    });
    const sealedAt = new Date(DAY_END.getTime() + 600_000);
    await repo.markSealed(row.id, { sealObjectId: '0x' + 'ab'.repeat(32), sealDigest: 'SealTx', sealedAt });
    seal = {
      sealObjectId: '0x' + 'ab'.repeat(32),
      organizationId: orgId,
      periodStartMs: DAY_START.getTime(),
      periodEndMs: DAY_END.getTime(),
      manifestHash: built.manifestHash,
      previousManifestHash: null,
      sealedAtMs: sealedAt.getTime(),
      transactionDigest: 'SealTx',
    };
    return row.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    const ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
    ]);
    const { memberId } = await seedMember(ctx.db, orgId);
    const at = new Date('2026-11-20T08:00:00.000Z');
    const [chainTx] = await ctx.db
      .insert(schema.blockchainTransactions)
      .values({ digest: 'Dg-earn', sender: '0x1', status: 'CONFIRMED', confirmedAt: at })
      .returning();
    const [earn] = await ctx.db
      .insert(schema.loyaltyTransactions)
      .values({
        organizationId: orgId,
        organizationEndUserId: memberId,
        blockchainTransactionId: chainTx.id,
        transactionType: 'EARN',
        pointsAmount: 100,
        purchaseAmount: 10_000,
        idempotencyKey: 'earn-1',
        status: 'CONFIRMED',
      })
      .returning();
    earnId = earn.id;
    // Next day's activity: not part of the sealed day.
    await ctx.db.insert(schema.auditLog).values([
      { organizationId: orgId, occurredAt: at, actorType: 'SYSTEM', action: 'member.blocked', targetType: 'member' },
      {
        organizationId: orgId,
        occurredAt: DAY_END,
        actorType: 'SYSTEM',
        action: 'member.unblocked',
        targetType: 'member',
      },
    ]);
    periodId = await sealDay();
  });

  it('lists the sealed periods with how far sealing has reached', async () => {
    const { body } = await ctx.http().get(path('')).set(as('owner')).expect(200);
    expect(body).toEqual({
      sealedThrough: DAY_END.toISOString(),
      periodCount: 1,
      nextCursor: null,
      items: [
        {
          id: periodId,
          periodStart: DAY_START.toISOString(),
          periodEnd: DAY_END.toISOString(),
          ledgerCount: 1,
          auditCount: 1,
          status: 'SEALED',
          archiveStatus: 'DISABLED',
        },
      ],
    });
  });

  it('shows a period’s seal', async () => {
    const { body } = await ctx
      .http()
      .get(path(`/${periodId}`))
      .set(as('owner'))
      .expect(200);
    expect(body.seal).toMatchObject({
      network: 'testnet',
      transactionDigest: 'SealTx',
      sealObjectId: seal.sealObjectId,
    });
    expect(body.manifestHash).toBe(seal.manifestHash);
  });

  it('gives a bundle that verifies against its seal, and names the ledger once a fact is edited', async () => {
    const res = await ctx
      .http()
      .get(path(`/${periodId}/bundle`))
      .set(as('owner'))
      .expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const bundle = res.body as EvidenceBundle;
    expect(bundle.ledger.map((f) => f.id)).toEqual([earnId]);
    expect(await verifyBundle(bundle, reader)).toMatchObject({ result: 'MATCH' });
    const again = await ctx
      .http()
      .get(path(`/${periodId}/bundle`))
      .set(as('owner'))
      .expect(200);
    expect(again.text).toBe(res.text);

    await ctx.db
      .update(schema.loyaltyTransactions)
      .set({ pointsAmount: 1000 })
      .where(eq(schema.loyaltyTransactions.id, earnId));
    const tampered = (
      await ctx
        .http()
        .get(path(`/${periodId}/bundle`))
        .set(as('owner'))
        .expect(200)
    ).body as EvidenceBundle;
    expect(await verifyBundle(tampered, reader)).toMatchObject({ result: 'MISMATCH', mismatched: ['ledger'] });
  });

  it('recomputes the period for the Verify button: MATCH, then MISMATCH once the data changes', async () => {
    const check = async () =>
      verifyRecomputation(
        (
          await ctx
            .http()
            .get(path(`/${periodId}/verification`))
            .set(as('owner'))
            .expect(200)
        ).body as EvidenceRecomputation,
        reader,
      );
    expect(await check()).toMatchObject({ result: 'MATCH' });
    // A status change is not a fact: a later reversal does not unseal the day.
    await ctx.db
      .update(schema.loyaltyTransactions)
      .set({ status: 'REVERSED' })
      .where(eq(schema.loyaltyTransactions.id, earnId));
    expect(await check()).toMatchObject({ result: 'MATCH' });
    await ctx.db.delete(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.id, earnId));
    expect(await check()).toMatchObject({ result: 'MISMATCH', mismatched: ['ledger'] });
  });

  it('is the Owner’s alone, and another organization’s period is not found', async () => {
    await ctx.http().get(path('')).set(as('developer')).expect(403);
    await ctx
      .http()
      .get(path(`/${periodId}/bundle`))
      .set(as('developer'))
      .expect(403);
    const other = (await seedOrganization(ctx.db)).id;
    await ctx.http().get(`/v1/console/organizations/${other}/evidence/${periodId}`).set(as('owner')).expect(403);
  });

  it('refuses a bundle while the period is still being sealed', async () => {
    const repo = ctx.app.get(EvidenceRepository);
    const next = await repo.insert({
      organizationId: orgId,
      periodStart: DAY_END,
      periodEnd: new Date(DAY_END.getTime() + 86_400_000),
      ledgerCount: 0,
      ledgerHash: 'x',
      auditCount: 1,
      auditHash: 'y',
      previousManifestHash: seal.manifestHash,
      manifestHash: 'z',
      network: 'testnet',
      archiveStatus: 'DISABLED',
    });
    await ctx
      .http()
      .get(path(`/${next.id}/bundle`))
      .set(as('owner'))
      .expect(409);
    const { body } = await ctx
      .http()
      .get(path(`/${next.id}`))
      .set(as('owner'))
      .expect(200);
    expect(body).toMatchObject({ status: 'SEALING', seal: null });
  });

  it('keeps the tenant role out of writing periods', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          (await import('drizzle-orm'))
            .sql`select set_config('role', 'authenticated', true), set_config('app.current_tenant_id', ${orgId}, true)`,
        );
        await tx
          .update(schema.evidencePeriods)
          .set({ manifestHash: 'forged' })
          .where(eq(schema.evidencePeriods.id, periodId));
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
