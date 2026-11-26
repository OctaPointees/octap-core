import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from '../support/app.js';
import {
  insertLoyaltyTransaction,
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
  setOwnership,
} from '../support/db.js';

const ACTORS = ['owner', 'developer', 'stranger'] as const;
type Actor = (typeof ACTORS)[number];

describe('on-chain evidence: org history, account ids, policy and balance reconciliation (OCT-334)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let alice: string;
  let bob: string;
  let key: { authorization: string };
  const google = {
    verify: async (token: string) => {
      if (!(ACTORS as readonly string[]).includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: token,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const console_ = (actor: Actor, path: string) =>
    ctx.http().get(`/v1/console/organizations/${orgId}${path}`).set(as(actor));

  async function confirmedEarn(memberId: string, points: number, at: Date) {
    const [chainTx] = await ctx.db
      .insert(schema.blockchainTransactions)
      .values({ digest: `D-${randomUUID()}`, sender: '0xissuer', status: 'CONFIRMED', confirmedAt: at })
      .returning();
    return insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: memberId,
      transactionType: 'EARN',
      pointsAmount: points,
      idempotencyKey: `earn-${randomUUID()}`,
      status: 'CONFIRMED',
      blockchainTransactionId: chainTx.id,
      createdAt: at,
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.adapters.suiBuilder.creditAccountSpendable.mockClear();
    orgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    alice = (await seedMember(ctx.db, orgId)).memberId;
    bob = (await seedMember(ctx.db, orgId)).memberId;
    key = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read'] })).rawKey}` };
    const ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
    ]);
  });

  it('lists the organization’s history newest first, with digest and confirmation time, filterable and paged', async () => {
    const first = await confirmedEarn(alice, 100, new Date('2026-11-01T00:00:00Z'));
    const second = await confirmedEarn(bob, 200, new Date('2026-11-02T00:00:00Z'));

    const all = (await ctx.http().get('/v1/credits/transactions').set(key).expect(200)).body;
    expect(all.items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    expect(all.items[0]).toMatchObject({
      blockchainDigest: expect.stringMatching(/^D-/),
      confirmedAt: '2026-11-02T00:00:00.000Z',
    });

    const onlyAlice = (await ctx.http().get('/v1/credits/transactions').query({ memberId: alice }).set(key)).body;
    expect(onlyAlice.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    const page = (await ctx.http().get('/v1/credits/transactions').query({ limit: '1' }).set(key)).body;
    expect(page.nextCursor).toBe(second.id);
    const next = (
      await ctx.http().get('/v1/credits/transactions').query({ limit: '1', cursor: page.nextCursor }).set(key)
    ).body;
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    await ctx.http().get('/v1/credits/transactions').query({ type: 'GIFT' }).set(key).expect(400);

    expect((await console_('developer', '/transactions').expect(200)).body.items).toHaveLength(2);
    await console_('stranger', '/transactions').expect(403);
  });

  it('keeps paging a status filter after the last row of a page changed status', async () => {
    const first = await confirmedEarn(alice, 100, new Date('2026-11-01T00:00:00Z'));
    const second = await confirmedEarn(bob, 200, new Date('2026-11-02T00:00:00Z'));
    const page = (
      await ctx.http().get('/v1/credits/transactions').query({ status: 'CONFIRMED', limit: '1' }).set(key).expect(200)
    ).body;
    expect(page.nextCursor).toBe(second.id);
    // The anchor leaves the filter (a PENDING earn the worker confirmed is the routine case).
    await ctx.db
      .update(schema.loyaltyTransactions)
      .set({ status: 'REVERSED' })
      .where(eq(schema.loyaltyTransactions.id, second.id));
    const next = (
      await ctx
        .http()
        .get('/v1/credits/transactions')
        .query({ status: 'CONFIRMED', limit: '1', cursor: page.nextCursor })
        .set(key)
        .expect(200)
    ).body;
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    // A cursor from another member's history is still refused.
    await ctx.http().get('/v1/credits/transactions').query({ memberId: alice, cursor: second.id }).set(key).expect(400);
  });

  it('shows the member’s CreditAccount id on their balance', async () => {
    await setOwnership(ctx.db, alice, { suiCreditAccountId: '0xalice', confirmedBalance: 0 });
    const balance = (await ctx.http().get(`/v1/credits/members/${alice}/balance`).set(key).expect(200)).body;
    expect(balance.creditAccountId).toBe('0xalice');
  });

  it('reconciles the recorded balance with the chain: MATCH, MISMATCH, PENDING', async () => {
    await setOwnership(ctx.db, alice, { suiCreditAccountId: '0xalice', confirmedBalance: 500 });
    ctx.adapters.suiBuilder.creditAccountSpendable.mockResolvedValueOnce(500n);
    const match = (await ctx.http().get(`/v1/credits/members/${alice}/reconciliation`).set(key).expect(200)).body;
    expect(match).toMatchObject({
      status: 'MATCH',
      creditAccountId: '0xalice',
      recordedBalance: 500,
      ledgerBalance: 500,
    });
    expect(ctx.adapters.suiBuilder.creditAccountSpendable).toHaveBeenCalledWith('0xalice');

    await setOwnership(ctx.db, bob, { suiCreditAccountId: '0xbob', confirmedBalance: 300 });
    ctx.adapters.suiBuilder.creditAccountSpendable.mockResolvedValueOnce(250n);
    const mismatch = (await console_('owner', `/members/${bob}/reconciliation`).expect(200)).body;
    expect(mismatch).toMatchObject({ status: 'MISMATCH', difference: -50 });

    const carol = (await seedMember(ctx.db, orgId)).memberId;
    await setOwnership(ctx.db, carol, { suiCreditAccountId: '0xcarol', confirmedBalance: 100 });
    await ctx.db.insert(schema.operations).values({
      tenantId: orgId,
      idempotencyKey: 'in-flight',
      commandType: 'CREDIT_REVERSAL_CHAIN_SUBMIT',
      status: 'PENDING',
      payload: { organizationEndUserId: carol },
    });
    ctx.adapters.suiBuilder.creditAccountSpendable.mockResolvedValueOnce(150n);
    const pending = (await ctx.http().get(`/v1/credits/members/${carol}/reconciliation`).set(key).expect(200)).body;
    expect(pending.status).toBe('PENDING');

    // A voucher claim is first recorded with `memberId` only; a voucher use never moves the balance.
    const dave = (await seedMember(ctx.db, orgId)).memberId;
    await setOwnership(ctx.db, dave, { suiCreditAccountId: '0xdave', confirmedBalance: 100 });
    await ctx.db.insert(schema.operations).values([
      {
        tenantId: orgId,
        idempotencyKey: 'claim',
        commandType: 'VOUCHER_CLAIM',
        status: 'PENDING',
        payload: { voucherId: randomUUID(), memberId: dave },
      },
    ]);
    ctx.adapters.suiBuilder.creditAccountSpendable.mockResolvedValueOnce(100n);
    expect((await ctx.http().get(`/v1/credits/members/${dave}/reconciliation`).set(key)).body.status).toBe('PENDING');

    const erin = (await seedMember(ctx.db, orgId)).memberId;
    await setOwnership(ctx.db, erin, { suiCreditAccountId: '0xerin', confirmedBalance: 100 });
    await ctx.db.insert(schema.operations).values({
      tenantId: orgId,
      idempotencyKey: 'use',
      commandType: 'VOUCHER_USE_RESERVE',
      status: 'PENDING',
      payload: { organizationEndUserId: erin },
    });
    ctx.adapters.suiBuilder.creditAccountSpendable.mockResolvedValueOnce(100n);
    expect((await ctx.http().get(`/v1/credits/members/${erin}/reconciliation`).set(key)).body.status).toBe('MATCH');

    await ctx.http().get(`/v1/credits/members/${randomUUID()}/reconciliation`).set(key).expect(404);
    await console_('stranger', `/members/${alice}/reconciliation`).expect(403);
  });

  it('shows the program and its frozen on-chain policy, compared with the rules OctaP applies', async () => {
    const program = (await ctx.http().get('/v1/credits/program').set(key).expect(200)).body;
    expect(program).toMatchObject({
      earnBps: 100,
      policyStatus: 'MATCH',
      policy: { version: 1, earnBps: 100, publishedDigest: 'POLICY-DIGEST', publishedAt: '2026-11-01T00:00:00.000Z' },
    });
    expect((await console_('developer', '/program').expect(200)).body.programControlId).toBe(program.programControlId);
    await console_('stranger', '/program').expect(403);
  });
});
