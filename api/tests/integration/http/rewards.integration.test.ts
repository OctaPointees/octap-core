import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VOUCHER_REFUND_POLICY } from '@octap/contracts';
import { createTestApp } from '../support/app.js';
import {
  schema,
  resetDb,
  seedProgram,
  seedCredential,
  seedMember,
  seedOrganization,
  setOwnership,
} from '../support/db.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;
let memberId: string;
let auth: { authorization: string };

beforeAll(async () => {
  ctx = await createTestApp();
});

beforeEach(async () => {
  await resetDb(ctx.db);
  orgId = (await seedOrganization(ctx.db)).id;
  memberId = (await seedMember(ctx.db, orgId)).memberId;
  auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
  await setOwnership(ctx.db, memberId, { confirmedBalance: 100, suiCreditAccountId: '0xaccount' });
  await seedProgram(ctx.db, orgId);
});

afterAll(async () => {
  await ctx.close();
});

const createVoucher = (body: Record<string, unknown>) => ctx.http().post('/v1/rewards/vouchers').set(auth).send(body);

describe('rewards over HTTP', () => {
  it('returns 409 for concurrent duplicate creation and 400 for impossible dates or active expired rewards', async () => {
    const input = { code: 'duplicate', title: 'Duplicate', discountType: 'FREE_ITEM' };
    const responses = await Promise.all([createVoucher(input), createVoucher(input)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await createVoucher({ ...input, code: 'invalid-date', startsAt: '2030-02-30T00:00:00Z' }).expect(400);
    await createVoucher({ ...input, code: 'expired', expiresAt: '2020-01-01T00:00:00Z' }).expect(400);
    const draft = await createVoucher({
      ...input,
      code: 'expired-draft',
      status: 'DRAFT',
      expiresAt: '2020-01-01T00:00:00Z',
    }).expect(201);
    await ctx.http().patch(`/v1/rewards/vouchers/${draft.body.id}`).set(auth).send({ status: 'ACTIVE' }).expect(400);
  });
  it('edits drafts, activates/pauses, validates merged fields and freezes claimed benefits', async () => {
    const created = await createVoucher({
      code: 'draft',
      title: 'Draft reward',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
      pointsCost: 25,
      totalSupply: 2,
      status: 'DRAFT',
    }).expect(201);
    const path = `/v1/rewards/vouchers/${created.body.id}`;
    await ctx
      .http()
      .post(`${path}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'draft-claim' })
      .expect(400);
    const updated = await ctx.http().patch(path).set(auth).send({ title: 'New reward', status: 'ACTIVE' }).expect(200);
    expect(updated.body).toMatchObject({ title: 'New reward', pointsCost: 25, status: 'ACTIVE' });
    await ctx.http().patch(path).set(auth).send({ discountValue: '101' }).expect(400);
    await ctx.http().patch(path).set(auth).send({ pointsCost: -1 }).expect(400);
    await ctx.http().patch(path).set(auth).send({ claimedCount: 0 }).expect(400);
    await ctx.http().patch(path).set(auth).send({}).expect(400);
    await ctx.http().patch('/v1/rewards/vouchers/not-a-uuid').set(auth).send({ title: 'X' }).expect(400);
    await ctx
      .http()
      .post(`${path}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'draft-claim' })
      .expect(201);
    await ctx.http().patch(path).set(auth).send({ pointsCost: 30 }).expect(409);
    await ctx.http().patch(path).set(auth).send({ expiresAt: '2030-01-01T00:00:00Z' }).expect(409);
    await ctx.http().patch(path).set(auth).send({ status: 'PAUSED' }).expect(200);
    const readonly = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read'] })).rawKey}` };
    await ctx.http().patch(path).set(readonly).send({ status: 'ACTIVE' }).expect(403);
    const other = await seedOrganization(ctx.db);
    const otherAuth = { authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` };
    await ctx.http().patch(path).set(otherAuth).send({ title: 'Foreign' }).expect(404);
  });

  it('returns the saved claim result on retries, rejects changed payloads and never charges twice', async () => {
    const voucher = await createVoucher({
      code: 'one',
      title: 'One',
      discountType: 'FREE_ITEM',
      pointsCost: 25,
      totalSupply: 1,
    }).expect(201);
    const path = `/v1/rewards/vouchers/${voucher.body.id}/claim`;
    const body = { organizationEndUserId: memberId, idempotencyKey: 'repeat-key' };
    const first = await ctx.http().post(path).set(auth).send(body).expect(201);
    const second = await ctx.http().post(path).set(auth).send(body).expect(201);
    expect(second.body).toEqual(first.body);
    const another = await createVoucher({
      code: 'two',
      title: 'Two',
      discountType: 'FREE_ITEM',
      pointsCost: 25,
    }).expect(201);
    await ctx.http().post(`/v1/rewards/vouchers/${another.body.id}/claim`).set(auth).send(body).expect(409);
    expect(
      (await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body.confirmedBalance,
    ).toBe(100);
  });
  it('create -> list/get -> claim (deducting points) -> redeem the serial -> member’s vouchers', async () => {
    const created = await createVoucher({
      code: 'coffee',
      title: 'Free coffee',
      discountType: 'FREE_ITEM',
      pointsCost: 60,
      totalSupply: 2,
    }).expect(201);
    expect(created.body).toMatchObject({ code: 'coffee', pointsCost: 60, status: 'ACTIVE', claimedCount: 0 });
    await createVoucher({ code: 'coffee', title: 'dup', discountType: 'FREE_ITEM' }).expect(409);

    expect((await ctx.http().get('/v1/rewards/vouchers').set(auth).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`/v1/rewards/vouchers/${created.body.id}`).set(auth).expect(200);

    const claimed = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${created.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'claim-1' })
      .expect(201);
    expect(claimed.body).toMatchObject({
      pointsDeducted: 0,
      pointsCost: 60,
      status: 'RESERVED',
      serialCode: expect.stringMatching(/^COFFEE-[0-9A-F]{16}$/),
    });
    expect((await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body).toMatchObject({
      confirmedBalance: 100,
      pendingRedemption: 60,
    });
    await ctx
      .http()
      .post('/v1/rewards/vouchers/redeem')
      .set(auth)
      .send({ serialCode: claimed.body.serialCode })
      .expect(400);
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claimed.body.digest, signature: 'customer-signature' })
      .expect(201);
    const status = await ctx.http().get(`/v1/rewards/claims/${claimed.body.voucherOwnershipId}`).set(auth).expect(200);
    expect(status.body).toMatchObject({ status: 'AVAILABLE', pointsDeducted: 60 });
    expect(
      (await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body.confirmedBalance,
    ).toBe(40);

    // Same member again: refused by the per-member uniqueness rule.
    await ctx
      .http()
      .post(`/v1/rewards/vouchers/${created.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'claim-2' })
      .expect(400);

    const redeemed = await ctx
      .http()
      .post('/v1/rewards/vouchers/redeem')
      .set(auth)
      .send({ serialCode: claimed.body.serialCode })
      .expect(201);
    expect(redeemed.body).toMatchObject({ status: 'REDEEMED', voucherTitle: 'Free coffee', discountType: 'FREE_ITEM' });
    await ctx
      .http()
      .post('/v1/rewards/vouchers/redeem')
      .set(auth)
      .send({ serialCode: claimed.body.serialCode })
      .expect(400);

    const mine = (await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(auth).expect(200)).body;
    expect(mine).toMatchObject([{ status: 'REDEEMED', voucher: { code: 'coffee' } }]);
  });

  it('keeps an unknown or invalid-signature claim reserved and releases it only on a definitive chain failure', async () => {
    const voucher = await createVoucher({
      code: 'recover',
      title: 'Recover',
      discountType: 'FREE_ITEM',
      pointsCost: 25,
      totalSupply: 1,
    }).expect(201);
    const request = { organizationEndUserId: memberId, idempotencyKey: 'recover-claim' };
    const claim = (
      await ctx.http().post(`/v1/rewards/vouchers/${voucher.body.id}/claim`).set(auth).send(request).expect(201)
    ).body;
    ctx.adapters.enoki.executeSponsoredTransaction.mockRejectedValueOnce(new Error('invalid signature'));
    await ctx.http().post('/v1/credits/redeem/finalize').send({ digest: claim.digest, signature: 'bad' }).expect(400);
    expect(
      (await ctx.http().get(`/v1/rewards/claims/${claim.voucherOwnershipId}`).set(auth).expect(200)).body.status,
    ).toBe('RESERVED');
    expect((await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body).toMatchObject({
      confirmedBalance: 100,
      pendingRedemption: 25,
    });
    ctx.adapters.suiBuilder.waitForTransaction.mockRejectedValueOnce(new Error('RPC timeout'));
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claim.digest, signature: 'customer-signature' })
      .expect(500);
    expect(
      (await ctx.http().get(`/v1/rewards/claims/${claim.voucherOwnershipId}`).set(auth).expect(200)).body.status,
    ).toBe('RESERVED');
    ctx.adapters.suiBuilder.waitForTransaction.mockResolvedValueOnce({
      digest: claim.digest,
      status: 'failure',
      errorMessage: 'EInsufficientBalance',
      events: [],
    } as never);
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claim.digest, signature: 'customer-signature' })
      .expect(400);
    expect(
      (await ctx.http().get(`/v1/rewards/claims/${claim.voucherOwnershipId}`).set(auth).expect(200)).body,
    ).toMatchObject({ status: 'CANCELLED', pointsDeducted: 0 });
    expect((await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body).toMatchObject({
      confirmedBalance: 100,
      pendingRedemption: 0,
    });
    expect((await ctx.http().get(`/v1/rewards/vouchers/${voucher.body.id}`).set(auth).expect(200)).body).toMatchObject({
      claimedCount: 0,
      status: 'ACTIVE',
    });
    const other = await seedOrganization(ctx.db);
    await ctx
      .http()
      .get(`/v1/rewards/claims/${claim.voucherOwnershipId}`)
      .set({ authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` })
      .expect(404);
  });

  it('replays a settled claim even if its program later becomes unavailable', async () => {
    const voucher = await createVoucher({
      code: 'settled',
      title: 'Settled',
      discountType: 'FREE_ITEM',
      pointsCost: 25,
    }).expect(201);
    const body = { organizationEndUserId: memberId, idempotencyKey: 'settled-claim' };
    const path = `/v1/rewards/vouchers/${voucher.body.id}/claim`;
    const claim = (await ctx.http().post(path).set(auth).send(body).expect(201)).body;
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claim.digest, signature: 'customer-signature' })
      .expect(201);
    await ctx.db
      .update(schema.programs)
      .set({ status: 'PROVISIONING' })
      .where(eq(schema.programs.organizationId, orgId));
    expect((await ctx.http().post(path).set(auth).send(body).expect(201)).body).toMatchObject({
      status: 'AVAILABLE',
      pointsDeducted: 25,
    });
  });

  it('a claim the member can’t afford is refused and changes nothing', async () => {
    const created = await createVoucher({
      code: 'big',
      title: 'Big',
      discountType: 'FIXED_AMOUNT',
      discountValue: '10.00',
      pointsCost: 500,
    }).expect(201);

    await ctx
      .http()
      .post(`/v1/rewards/vouchers/${created.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId })
      .expect(400);

    expect((await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(auth).expect(200)).body).toEqual([]);
  });

  it('keeps tenants apart and validates bodies', async () => {
    const other = await seedOrganization(ctx.db);
    const otherAuth = { authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` };
    const created = await createVoucher({
      code: 'mine',
      title: 'Mine',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
    }).expect(201);

    await ctx.http().get(`/v1/rewards/vouchers/${created.body.id}`).set(otherAuth).expect(404);
    await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(otherAuth).expect(404);
    await createVoucher({ title: 'no code' }).expect(400);
    await ctx.http().post(`/v1/rewards/vouchers/${created.body.id}/claim`).set(auth).send({}).expect(400);
    await ctx.http().post('/v1/rewards/vouchers/redeem').set(auth).send({}).expect(400);
  });
});

describe('voucher refund policy over HTTP', () => {
  it.each(['REDEEMED', 'EXPIRED', 'AVAILABLE_PAST_EXPIRY'] as const)(
    'requires authenticated admin scope for a policy-enabled %s refund and rolls back denied writes',
    async (state) => {
      const adminCredential = await seedCredential(ctx.db, orgId, { scopes: ['read', 'write', 'admin'] });
      const admin = { authorization: `Bearer ${adminCredential.rawKey}` };
      await ctx
        .http()
        .put('/v1/rewards/refund-policy')
        .set(admin)
        .send({
          allowUnused: true,
          allowExpired: true,
          allowRedeemed: true,
          restockUnused: true,
          refundWindowDays: null,
          reason: 'Exceptional service recovery refunds',
        })
        .expect(200);
      const voucher = await createVoucher({
        code: 'ADMIN-REFUND',
        title: 'Service recovery',
        discountType: 'FREE_ITEM',
        pointsCost: 25,
        totalSupply: 1,
      }).expect(201);
      const { body: claim } = await ctx
        .http()
        .post(`/v1/rewards/vouchers/${voucher.body.id}/claim`)
        .set(auth)
        .send({ organizationEndUserId: memberId, idempotencyKey: 'admin-refund-claim' })
        .expect(201);
      await ctx
        .http()
        .post('/v1/credits/redeem/finalize')
        .send({ digest: claim.digest, signature: 'customer-signature' })
        .expect(201);
      if (state === 'REDEEMED') {
        await ctx
          .http()
          .post('/v1/rewards/vouchers/redeem')
          .set(auth)
          .send({ serialCode: claim.serialCode })
          .expect(201);
      } else {
        await ctx.db
          .update(schema.voucherOwnerships)
          .set({
            status: state === 'EXPIRED' ? 'EXPIRED' : 'AVAILABLE',
            expiresAt: new Date(Date.now() - 1000),
          })
          .where(eq(schema.voucherOwnerships.id, claim.voucherOwnershipId));
      }
      const reversePath = `/v1/credits/transactions/${claim.transactionId}/reverse`;
      const input = { idempotencyKey: 'admin-refund', reason: 'Service recovery', scopes: ['admin'] };
      // Forged body scopes must not elevate the writer's credential.
      const denied = await ctx.http().post(reversePath).set(auth).send(input).expect(403);
      expect(denied.body.message).toContain('admin-scoped credential');
      const original = await ctx.db.query.loyaltyTransactions.findFirst({
        where: eq(schema.loyaltyTransactions.id, claim.transactionId),
      });
      expect(original?.status).toBe('CONFIRMED');
      expect(
        await ctx.db
          .select()
          .from(schema.loyaltyTransactions)
          .where(eq(schema.loyaltyTransactions.transactionType, 'REVERSAL')),
      ).toEqual([]);
      expect(
        (await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body.confirmedBalance,
      ).toBe(75);
      const foreignOrg = await seedOrganization(ctx.db);
      const foreign = { authorization: `Bearer ${(await seedCredential(ctx.db, foreignOrg.id)).rawKey}` };
      await ctx.http().post(reversePath).set(foreign).send(input).expect(404);
      const result = await ctx.http().post(reversePath).set(admin).send(input).expect(201);
      expect(result.body.newBalance).toBe(100);
      const reversal = await ctx.db.query.loyaltyTransactions.findFirst({
        where: eq(schema.loyaltyTransactions.id, result.body.reversalTransactionId),
      });
      expect(reversal?.metadata).toMatchObject({
        voucherRefund: { refundedByCredentialId: adminCredential.credential.id },
      });
      expect((await ctx.http().post(reversePath).set(admin).send(input).expect(201)).body.reversalTransactionId).toBe(
        result.body.reversalTransactionId,
      );
      const coupon = await ctx.db.query.voucherOwnerships.findFirst({
        where: eq(schema.voucherOwnerships.id, claim.voucherOwnershipId),
      });
      expect(coupon?.status).toBe(state === 'REDEEMED' ? 'REDEEMED' : 'EXPIRED');
      expect(
        (await ctx.http().get(`/v1/rewards/vouchers/${voucher.body.id}`).set(auth).expect(200)).body,
      ).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    },
  );

  it('allows a write-scoped credential to cancel an unused coupon without restocking when configured', async () => {
    const admin = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    await ctx
      .http()
      .put('/v1/rewards/refund-policy')
      .set(admin)
      .send({
        allowUnused: true,
        allowExpired: false,
        allowRedeemed: false,
        restockUnused: false,
        refundWindowDays: 1,
        reason: 'Each claim consumes a limited campaign allocation',
      })
      .expect(200);
    const voucher = await createVoucher({
      code: 'NO-RESTOCK',
      title: 'Limited allocation',
      discountType: 'FREE_ITEM',
      pointsCost: 25,
      totalSupply: 1,
    }).expect(201);
    const { body: claim } = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${voucher.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'no-restock-claim' })
      .expect(201);
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claim.digest, signature: 'customer-signature' })
      .expect(201);
    const reversal = await ctx
      .http()
      .post(`/v1/credits/transactions/${claim.transactionId}/reverse`)
      .set(auth)
      .send({ idempotencyKey: 'no-restock-refund', reason: 'Customer cancellation' })
      .expect(201);
    expect(reversal.body.newBalance).toBe(100);
    expect(
      (await ctx.http().get(`/v1/rewards/claims/${claim.voucherOwnershipId}`).set(auth).expect(200)).body.status,
    ).toBe('CANCELLED');
    expect((await ctx.http().get(`/v1/rewards/vouchers/${voucher.body.id}`).set(auth).expect(200)).body).toMatchObject({
      claimedCount: 1,
      status: 'DEPLETED',
    });
  });
  const settings = {
    allowUnused: true,
    allowExpired: false,
    allowRedeemed: false,
    restockUnused: true,
    refundWindowDays: null as number | null,
  };
  const request = { ...settings, allowExpired: true, refundWindowDays: 30, reason: 'Customer service policy' };
  const path = '/v1/rewards/refund-policy';

  it('requires admin scope to publish/history, scopes reads to the credential tenant, and records each version', async () => {
    expect((await ctx.http().get(path).set(auth).expect(200)).body).toMatchObject(DEFAULT_VOUCHER_REFUND_POLICY);
    await ctx.http().put(path).set(auth).send(request).expect(403);
    await ctx
      .http()
      .get(path + '/history')
      .set(auth)
      .expect(403);
    const admin = await seedCredential(ctx.db, orgId, { scopes: ['admin'] });
    const adminAuth = { authorization: `Bearer ${admin.rawKey}` };
    const first = await ctx.http().put(path).set(adminAuth).send(request).expect(200);
    expect(first.body).toMatchObject({
      version: 1,
      allowExpired: true,
      reason: request.reason,
      createdByCredentialId: admin.credential.id,
    });
    const simultaneous = await Promise.all([
      ctx
        .http()
        .put(path)
        .set(adminAuth)
        .send({ ...request, reason: 'Version A' }),
      ctx
        .http()
        .put(path)
        .set(adminAuth)
        .send({ ...request, reason: 'Version B' }),
    ]);
    expect(simultaneous.map((r) => r.status)).toEqual([200, 200]);
    expect(simultaneous.map((r) => r.body.version).sort()).toEqual([2, 3]);
    expect(
      (
        await ctx
          .http()
          .get(path + '/history')
          .set(adminAuth)
          .expect(200)
      ).body.map((r: { version: number }) => r.version),
    ).toEqual([3, 2, 1]);
    expect((await ctx.http().get(path).set(auth).expect(200)).body.version).toBe(3);
    const firstPage = await ctx
      .http()
      .get(path + '/history?limit=2')
      .set(adminAuth)
      .expect(200);
    expect(firstPage.body.map((row: { version: number }) => row.version)).toEqual([3, 2]);
    const secondPage = await ctx
      .http()
      .get(path + '/history?limit=2&beforeVersion=2')
      .set(adminAuth)
      .expect(200);
    expect(secondPage.body.map((row: { version: number }) => row.version)).toEqual([1]);
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'beforeVersion=0',
      'beforeVersion=2147483648',
      'beforeVersion=no',
    ]) {
      await ctx
        .http()
        .get(path + '/history?' + query)
        .set(adminAuth)
        .expect(400);
    }

    const other = await seedOrganization(ctx.db);
    const foreign = { authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` };
    expect((await ctx.http().get(path).set(foreign).expect(200)).body.version).toBe(0);
    expect(
      (
        await ctx
          .http()
          .get(path + '/history')
          .set(foreign)
          .expect(200)
      ).body,
    ).toEqual([]);
    await ctx.http().put(path).set(foreign).set('x-organization-id', orgId).send(request).expect(403);
  });

  it('validates full policy replacements and exposes the snapshot on claim/member reads', async () => {
    const admin = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    await ctx
      .http()
      .put(path)
      .set(admin)
      .send({ ...request, reason: '' })
      .expect(400);
    await ctx
      .http()
      .put(path)
      .set(admin)
      .send({ ...request, refundWindowDays: -1 })
      .expect(400);
    await ctx.http().put(path).set(admin).send(request).expect(200);
    const voucher = await createVoucher({ code: 'SNAPSHOT', title: 'Snapshot', discountType: 'FREE_ITEM' }).expect(201);
    const claim = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${voucher.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'snapshot' })
      .expect(201);
    expect(claim.body.refundPolicy).toMatchObject({ version: 1, allowExpired: true, refundWindowDays: 30 });
    const owned = await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(auth).expect(200);
    expect(owned.body[0].refundPolicy).toEqual(claim.body.refundPolicy);
    await ctx.http().get(path).expect(401);
  });
});
