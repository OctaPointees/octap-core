import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_VOUCHER_REFUND_POLICY } from '@octap/contracts';
import { evaluateVoucherRefund } from '#domain/rewards/refund-policy.js';
import { withRls } from '#infra/db/rls.js';
import { VoucherRefundPoliciesRepository } from '#infra/db/repositories/voucher-refund-policies.repository.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import {
  connectTestDb,
  resetDb,
  schema,
  seedMember,
  seedOrganization,
  seedCredential,
  setOwnership,
  getOwnership,
  insertLoyaltyTransaction,
} from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new RewardsRepository(db);
let orgId: string;
let memberId: string;
beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
  memberId = (await seedMember(db, orgId)).memberId;
  await setOwnership(db, memberId, { confirmedBalance: 100, lifetimeEarned: 100, suiCreditAccountId: '0xaccount' });
});
afterAll(() => client.end());
const draft = (overrides: Partial<Parameters<RewardsRepository['createVoucher']>[0]> = {}) =>
  repo.createVoucher({
    organizationId: orgId,
    code: 'COFFEE',
    title: 'Coffee',
    discountType: 'FREE_ITEM',
    pointsCost: 25,
    ...overrides,
  });
/** A voucher as the worker leaves it once the chain holds its terms, with that command out of the way. */
const create = async (overrides: Partial<Parameters<RewardsRepository['createVoucher']>[0]> = {}) => {
  const voucher = await draft(overrides);
  await repo.markVoucherPublished(voucher.id, `0xterms-${voucher.id}`);
  await db.delete(schema.operations).where(eq(schema.operations.commandType, 'VOUCHER_TERMS_PUBLISH'));
  return (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucher.id)))[0];
};
const claim = (voucherId: string, key = 'claim-1', member = memberId) =>
  repo.claimVoucher(orgId, voucherId, member, key);
let useCount = 0;
/** What the customer's signature leads to: the use is accepted, then the chain confirms it. */
const use = async (serialCode: string, organizationId = orgId) => {
  const { ownership } = await repo.reserveVoucherUse({
    organizationId,
    serialCode,
    idempotencyKey: `use-${++useCount}`,
  });
  const confirmed = await repo.confirmVoucherUse({
    voucherOwnershipId: ownership.id,
    digest: `use-digest-${useCount}`,
  });
  return confirmed!;
};
const row = async (id: string) => (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)))[0];

const credits = new CreditsRepository(db);
const confirm = async (result: Awaited<ReturnType<typeof claim>>) => {
  await credits.confirmPosRedemptionOnChain({
    loyaltyTransactionId: result.transactionId!,
    organizationEndUserId: result.organizationEndUserId,
    pointsAmount: result.pointsCost!,
    digest: `chain-${result.transactionId}`,
    sender: '0xmember',
  });
  return repo.getClaim(orgId, result.voucherOwnershipId);
};

describe('atomic voucher conversion', () => {
  it('returns a conflict when the same voucher code is created concurrently', async () => {
    const results = await Promise.allSettled([create(), create(), create()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ kind: 'CONFLICT' });
    }
    expect(await repo.listVouchersByOrganization(orgId)).toHaveLength(1);
  });

  it('does not spend points reserved for a pending POS redemption', async () => {
    await setOwnership(db, memberId, { pendingRedemption: 80 });
    const voucher = await create({ pointsCost: 25 });
    await expect(claim(voucher.id)).rejects.toThrow(/Insufficient/);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 80 });
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(0);
    expect(await db.select().from(schema.operations)).toHaveLength(0);
  });

  it('serializes a POS reserve and voucher claim against the same spendable points', async () => {
    await setOwnership(db, memberId, { suiCreditAccountId: '0xaccount' });
    const voucher = await create({ pointsCost: 30 });
    const credits = new CreditsRepository(db);
    const results = await Promise.allSettled([
      credits.reservePosRedemption({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 80,
        idempotencyKey: 'pos-reserve',
      }),
      claim(voucher.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const balance = await getOwnership(db, memberId);
    expect(balance.confirmedBalance - balance.pendingRedemption).toBeGreaterThanOrEqual(0);
  });

  it('rejects unsafe point arithmetic without writing a claim', async () => {
    const voucher = await create();
    await setOwnership(db, memberId, { confirmedBalance: Number.MAX_SAFE_INTEGER + 1 });
    await expect(claim(voucher.id)).rejects.toThrow(/precision/);
    await setOwnership(db, memberId, { confirmedBalance: 100, lifetimeRedeemed: Number.MAX_SAFE_INTEGER });
    await expect(claim(voucher.id)).rejects.toThrow(/precision/);
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(0);
  });

  it('creates one debit, ownership, saved response and webhook; replay survives depletion and redemption', async () => {
    const voucher = await create({ totalSupply: 1 });
    await db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://example.com/hook', secret: 'test-secret' });
    const result = await claim(voucher.id);
    expect(result).toMatchObject({ pointsDeducted: 0, pointsCost: 25, status: 'RESERVED' });
    expect(await db.select().from(schema.operations)).toMatchObject([
      { commandType: 'VOUCHER_CLAIM_RESERVE', status: 'PENDING' },
    ]);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 25 });
    await expect(use(result.serialCode)).rejects.toThrow(/RESERVED/);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(0);
    const confirmed = await confirm(result);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 75, pendingRedemption: 0 });
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    expect(await claim(voucher.id)).toEqual(confirmed);
    await use(result.serialCode);
    expect(await claim(voucher.id)).toMatchObject({ ...confirmed, status: 'REDEEMED' });
    expect(await db.select().from(schema.loyaltyTransactions)).toHaveLength(1);
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(1);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(2);
  });

  it('serializes simultaneous retries of one key and rejects changed payloads', async () => {
    const voucher = await create();
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(voucher.id)));
    expect(results.every((result) => result.voucherOwnershipId === results[0].voucherOwnershipId)).toBe(true);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 25 });
    const other = await create({ code: 'OTHER' });
    await expect(claim(other.id)).rejects.toThrow(/different payload/);
    const second = (await seedMember(db, orgId)).memberId;
    await expect(claim(voucher.id, 'claim-1', second)).rejects.toThrow(/different payload/);
  });

  it('does not deduct points for another key after a member already claimed', async () => {
    const voucher = await create();
    await claim(voucher.id);
    await expect(claim(voucher.id, 'claim-2')).rejects.toThrow(/already been claimed/);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 25 });
    expect(await db.select().from(schema.operations)).toHaveLength(1);
  });

  it('cannot oversell the final unit to two different members', async () => {
    const voucher = await create({ totalSupply: 1 });
    const second = (await seedMember(db, orgId)).memberId;
    await setOwnership(db, second, { confirmedBalance: 100, suiCreditAccountId: '0xsecond' });
    const results = await Promise.allSettled([claim(voucher.id), claim(voucher.id, 'claim-2', second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(1);
    expect(
      (await getOwnership(db, memberId)).confirmedBalance + (await getOwnership(db, second)).confirmedBalance,
    ).toBe(200);
    expect((await row(voucher.id)).claimedCount).toBe(1);
  });

  it('cannot overspend a shared balance when different rewards are claimed concurrently', async () => {
    const first = await create({ pointsCost: 60 });
    const second = await create({ code: 'OTHER', pointsCost: 60 });
    const results = await Promise.allSettled([claim(first.id), claim(second.id, 'claim-2')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 60 });
    expect(await db.select().from(schema.loyaltyTransactions)).toHaveLength(1);
  });

  it('rolls back the debit, stock, operation and webhook if ownership insertion fails', async () => {
    const voucher = await create();
    await db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://example.com/hook', secret: 'test-secret' });
    await client.unsafe(`CREATE FUNCTION fail_demo_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ownership failure'; END $$;
      CREATE TRIGGER fail_demo_claim BEFORE INSERT ON voucher_ownerships FOR EACH ROW EXECUTE FUNCTION fail_demo_claim();`);
    try {
      await expect(claim(voucher.id)).rejects.toThrow();
      expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
      expect((await row(voucher.id)).claimedCount).toBe(0);
      for (const table of [
        schema.loyaltyTransactions,
        schema.voucherOwnerships,
        schema.operations,
        schema.webhookDeliveries,
      ]) {
        expect(await db.select().from(table)).toHaveLength(0);
      }
    } finally {
      await client.unsafe('DROP TRIGGER fail_demo_claim ON voucher_ownerships; DROP FUNCTION fail_demo_claim();');
    }
    // The failed attempt did not consume its idempotency key.
    expect((await claim(voucher.id)).pointsDeducted).toBe(0);
    expect((await getOwnership(db, memberId)).pendingRedemption).toBe(25);
  });

  it('rejects insufficient funds and invalid availability without business writes', async () => {
    const expensive = await create({ pointsCost: 500 });
    await expect(claim(expensive.id)).rejects.toThrow(/Insufficient/);
    const future = await create({ code: 'FUTURE', startsAt: new Date(Date.now() + 86400000) });
    await expect(claim(future.id)).rejects.toThrow(/not started/);
    const expired = await create({ code: 'OLD', expiresAt: new Date(Date.now() - 1000) });
    await expect(claim(expired.id)).rejects.toThrow(/expired/);
    const paused = await create({ code: 'PAUSED', status: 'PAUSED' });
    await expect(claim(paused.id)).rejects.toThrow(/not active/);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
    expect(await db.select().from(schema.operations)).toHaveLength(0);
  });

  it('excludes expired credit buckets and consumes live buckets in the same transaction', async () => {
    const balance = await getOwnership(db, memberId);
    for (const [key, amount, expiresAtMs] of [
      ['old', 80, Date.now() - 1000],
      ['live', 20, Date.now() + 86400000],
    ] as const) {
      const earn = await insertLoyaltyTransaction(db, {
        organizationId: orgId,
        organizationEndUserId: memberId,
        transactionType: 'EARN',
        pointsAmount: amount,
        idempotencyKey: key,
        status: 'CONFIRMED',
      });
      await db
        .insert(schema.creditBuckets)
        .values({ creditOwnershipId: balance.id, earnTransactionId: earn.id, amount, remaining: amount, expiresAtMs });
    }
    const voucher = await create({ pointsCost: 25 });
    await expect(claim(voucher.id)).rejects.toThrow(/Insufficient/);
    await db.update(schema.vouchers).set({ pointsCost: 10 }).where(eq(schema.vouchers.id, voucher.id));
    await confirm(await claim(voucher.id));
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(10);
    expect((await db.select().from(schema.creditBuckets)).reduce((sum, bucket) => sum + bucket.remaining, 0)).toBe(10);
  });

  it('enforces organization and member eligibility even for free rewards', async () => {
    const voucher = await create({ pointsCost: 0 });
    const other = await seedOrganization(db);
    await expect(repo.claimVoucher(other.id, voucher.id, memberId, 'other-key')).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    });
    const foreignMember = (await seedMember(db, other.id)).memberId;
    await expect(claim(voucher.id, 'foreign-key', foreignMember)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await db
      .update(schema.organizationEndUsers)
      .set({ status: 'BLOCKED' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    await expect(claim(voucher.id)).rejects.toThrow(/Member is not active/);
    await db
      .update(schema.organizationEndUsers)
      .set({ status: 'ACTIVE' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    await db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await expect(claim(voucher.id)).rejects.toThrow(/Organization is not active/);
  });

  it('releases stock and points on definitive failure, permits a new claim, and never applies a late confirmation', async () => {
    const voucher = await create({ totalSupply: 1 });
    const reserved = await claim(voucher.id);
    await credits.failPosRedemptionOnChain({
      loyaltyTransactionId: reserved.transactionId!,
      organizationEndUserId: memberId,
      pointsAmount: 25,
    });
    expect(await repo.getClaim(orgId, reserved.voucherOwnershipId)).toMatchObject({
      status: 'CANCELLED',
      pointsDeducted: 0,
    });
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 0, status: 'ACTIVE' });
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 0 });
    expect(await claim(voucher.id)).toMatchObject({ status: 'CANCELLED' });
    await confirm(reserved);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
    const retry = await claim(voucher.id, 'new-key');
    expect(retry.voucherOwnershipId).not.toBe(reserved.voucherOwnershipId);
    await confirm(retry);
    await confirm(retry);
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 75, pendingRedemption: 0 });
    await expect(repo.getClaim((await seedOrganization(db)).id, retry.voucherOwnershipId)).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    });
  });

  it('does not release an unsigned claim once finalize has pinned a digest; abandonment prevents late execution', async () => {
    const voucher = await create();
    const reserved = await claim(voucher.id);
    const operationsRepo = new OperationsRepository(db);
    const params = {
      loyaltyTransactionId: reserved.transactionId!,
      organizationEndUserId: memberId,
      pointsAmount: 25,
      onlyIfUnsubmitted: true,
    };
    await operationsRepo.recordSubmitDigestForCommand({
      tenantId: orgId,
      idempotencyKey: 'claim-1',
      suiTxDigest: 'submitted',
      expirationEpoch: 5n,
    });
    expect(await credits.failPosRedemptionOnChain(params)).toBe(false);
    expect((await repo.getClaim(orgId, reserved.voucherOwnershipId)).status).toBe('RESERVED');
    await confirm(reserved);
    const other = await create({ code: 'OTHER' });
    const abandoned = await claim(other.id, 'abandoned');
    expect(await credits.failPosRedemptionOnChain({ ...params, loyaltyTransactionId: abandoned.transactionId! })).toBe(
      true,
    );
    expect(
      await operationsRepo.recordSubmitDigestForCommand({
        tenantId: orgId,
        idempotencyKey: 'abandoned',
        suiTxDigest: 'late',
        expirationEpoch: 5n,
      }),
    ).toBeNull();
    expect((await row(other.id)).claimedCount).toBe(0);
  });

  const reverseClaim = async (result: Awaited<ReturnType<typeof confirm>>, idempotencyKey = 'refund') =>
    credits.recordReversalTransaction({
      evaluateRefund: evaluateVoucherRefund,
      organizationId: orgId,
      original: (await credits.getLoyaltyTransactionById(result.transactionId!))!,
      idempotencyKey,
      reason: 'refund',
    });

  it('reverses an unused claim with its original on-chain reference, cancelling the coupon and returning its unit', async () => {
    const voucher = await create({ totalSupply: 1 });
    const result = await confirm(await claim(voucher.id));
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    await reverseClaim(result);
    const reversal = (await db.select().from(schema.operations)).find(
      (o) => o.commandType === 'CREDIT_REVERSAL_CHAIN_SUBMIT',
    );
    expect(reversal?.payload).toMatchObject({ chainKey: `voucher-claim-${result.voucherOwnershipId}` });
    expect((await repo.getClaim(orgId, result.voucherOwnershipId)).status).toBe('CANCELLED');
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 0, status: 'ACTIVE' });
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
    await expect(use(result.serialCode)).rejects.toThrow(/CANCELLED/);
  });

  it.each([
    ['REDEEMED', 'used at checkout', (serial: string) => use(serial).then(() => undefined)],
    [
      'EXPIRED',
      'marked expired',
      (serial: string) =>
        db
          .update(schema.voucherOwnerships)
          .set({ status: 'EXPIRED' })
          .where(eq(schema.voucherOwnerships.serialCode, serial))
          .then(() => undefined),
    ],
    [
      'EXPIRED',
      'past its expiry but not yet marked',
      (serial: string) =>
        db
          .update(schema.voucherOwnerships)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.voucherOwnerships.serialCode, serial))
          .then(() => undefined),
    ],
  ] as const)('refuses to reverse a claim whose coupon is %s (%s) and writes nothing', async (status, _, settle) => {
    const voucher = await create();
    const result = await confirm(await claim(voucher.id));
    await settle(result.serialCode);
    await expect(reverseClaim(result)).rejects.toThrow(new RegExp(`coupon status: ${status}`));
    expect(await credits.getLoyaltyTransactionById(result.transactionId!)).toMatchObject({ status: 'CONFIRMED' });
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
    expect((await row(voucher.id)).claimedCount).toBe(1);
    expect(
      (await db.select().from(schema.loyaltyTransactions)).filter((t) => t.transactionType === 'REVERSAL'),
    ).toHaveLength(0);
  });

  it('a coupon used and reversed at the same time is either used or refunded, never both', async () => {
    const result = await confirm(await claim((await create()).id));
    const [used, reversed] = await Promise.allSettled([use(result.serialCode), reverseClaim(result)]);
    expect([used.status, reversed.status].sort()).toEqual(['fulfilled', 'rejected']);
    const coupon = await repo.getClaim(orgId, result.voucherOwnershipId);
    const balance = (await getOwnership(db, memberId)).confirmedBalance;
    expect({ coupon: coupon.status, balance }).toEqual(
      used.status === 'fulfilled' ? { coupon: 'REDEEMED', balance: 75 } : { coupon: 'CANCELLED', balance: 100 },
    );
  });

  it('retains the confirmed debit when an issued coupon later expires', async () => {
    const result = await confirm(await claim((await create()).id));
    await db
      .update(schema.voucherOwnerships)
      .set({ status: 'EXPIRED' })
      .where(eq(schema.voucherOwnerships.id, result.voucherOwnershipId));
    expect(await repo.getClaim(orgId, result.voucherOwnershipId)).toMatchObject({
      status: 'EXPIRED',
      pointsDeducted: 25,
    });
  });

  it('lazy balance cleanup cancels an abandoned coupon and releases both its points and stock exactly once', async () => {
    const voucher = await create({ totalSupply: 1 });
    const reserved = await claim(voucher.id);
    await db.update(schema.operations).set({ updatedAt: new Date(Date.now() - 31 * 60 * 1000) });
    const member = { organizationId: orgId, organizationEndUserId: memberId };
    expect(await credits.releaseAbandonedPosHoldsForMember(member)).toBe(25);
    expect(await credits.releaseAbandonedPosHoldsForMember(member)).toBe(0);
    expect(await repo.getClaim(orgId, reserved.voucherOwnershipId)).toMatchObject({
      status: 'CANCELLED',
      pointsDeducted: 0,
    });
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 0 });
    expect(await row(voucher.id)).toMatchObject({ status: 'ACTIVE', claimedCount: 0 });
  });

  it('continuing an unsigned voucher refreshes its age, while a submitted claim is never released by age', async () => {
    const first = await claim((await create()).id);
    const second = await claim((await create({ code: 'SECOND' })).id, 'claim-2');
    await db.update(schema.operations).set({ updatedAt: new Date(Date.now() - 31 * 60 * 1000) });
    await db
      .update(schema.operations)
      .set({ suiTxDigest: 'submitted' })
      .where(eq(schema.operations.idempotencyKey, 'claim-2'));
    expect((await claim(first.voucherId)).status).toBe('RESERVED');
    expect(
      await credits.releaseAbandonedPosHoldsForMember({ organizationId: orgId, organizationEndUserId: memberId }),
    ).toBe(0);
    expect((await repo.getClaim(orgId, second.voucherOwnershipId)).status).toBe('RESERVED');
    expect((await getOwnership(db, memberId)).pendingRedemption).toBe(50);
  });

  it('a failed new claim still commits abandonment cleanup of the previous attempt', async () => {
    const first = await claim((await create({ totalSupply: 1 })).id);
    await db.update(schema.operations).set({ updatedAt: new Date(Date.now() - 31 * 60 * 1000) });
    const costly = await create({ code: 'COSTLY', pointsCost: 500 });
    await expect(claim(costly.id, 'too-expensive')).rejects.toThrow(/Insufficient/);
    expect((await repo.getClaim(orgId, first.voucherOwnershipId)).status).toBe('CANCELLED');
    expect((await row(first.voucherId)).claimedCount).toBe(0);
    expect((await getOwnership(db, memberId)).pendingRedemption).toBe(0);
  });

  it('supports free reward replay without a points debit and rejects keys owned by other commands', async () => {
    const voucher = await create({ pointsCost: 0 });
    const result = await claim(voucher.id);
    expect(await claim(voucher.id)).toEqual(result);
    expect(await db.select().from(schema.loyaltyTransactions)).toHaveLength(0);
    expect(await db.select().from(schema.operations)).toMatchObject([
      { commandType: 'VOUCHER_GRANT', status: 'PENDING' },
    ]);
    const second = await create({ code: 'SECOND' });
    await db
      .insert(schema.operations)
      .values({ tenantId: orgId, idempotencyKey: 'earn-key', commandType: 'CREDIT_EARN_CHAIN_SUBMIT', payload: {} });
    await expect(claim(second.id, 'earn-key')).rejects.toThrow(/different payload/);
  });
});

describe('single-use redemption and lifecycle locking', () => {
  it('treats equivalent decimal discounts as unchanged after a claim', async () => {
    const voucher = await create({ discountType: 'PERCENTAGE', discountValue: '10.00' });
    await claim(voucher.id);
    expect((await repo.updateVoucher(orgId, voucher.id, { discountValue: '10' }, () => {})).discountValue).toBe(
      '10.00',
    );
    await expect(repo.updateVoucher(orgId, voucher.id, { discountValue: '11' }, () => {})).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
  });

  it('does not activate expired rewards or reduce stock below claimed supply', async () => {
    const expired = await create({ code: 'EXPIRED', status: 'DRAFT', expiresAt: new Date(Date.now() - 1000) });
    await expect(repo.updateVoucher(orgId, expired.id, { status: 'ACTIVE' }, () => {})).rejects.toMatchObject({
      kind: 'INVALID',
    });
    const voucher = await create({ totalSupply: 2 });
    await claim(voucher.id);
    await expect(repo.updateVoucher(orgId, voucher.id, { totalSupply: 0 }, () => {})).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    await repo.updateVoucher(orgId, voucher.id, { totalSupply: 1 }, () => {});
    await expect(repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    const restocked = await repo.updateVoucher(orgId, voucher.id, { totalSupply: 2 }, () => {});
    expect(restocked.status).toBe('DEPLETED');
    expect((await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).status).toBe('ACTIVE');
  });

  it('allows only one simultaneous redemption and rejects foreign organizations', async () => {
    const voucher = await create();
    const result = await confirm(await claim(voucher.id));
    const other = await seedOrganization(db);
    await expect(use(result.serialCode, other.id)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    const results = await Promise.allSettled([use(result.serialCode), use(result.serialCode)]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.getClaim(orgId, result.voucherOwnershipId)).status).toBe('REDEEMED');
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 75, pendingRedemption: 0 });
  });

  it('rejects expired ownership, preserves issued benefits when paused and freezes economic fields', async () => {
    const voucher = await create();
    const result = await confirm(await claim(voucher.id));
    await expect(repo.updateVoucher(orgId, voucher.id, { pointsCost: 30 }, () => {})).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    await repo.updateVoucher(orgId, voucher.id, { status: 'PAUSED' }, () => {});
    await db
      .update(schema.voucherOwnerships)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.voucherOwnerships.id, result.voucherOwnershipId));
    await expect(use(result.serialCode)).rejects.toThrow(/expired/);
    await db
      .update(schema.voucherOwnerships)
      .set({ expiresAt: null })
      .where(eq(schema.voucherOwnerships.id, result.voucherOwnershipId));
    expect((await use(result.serialCode)).ownership.status).toBe('REDEEMED');
  });
});

describe('voucher terms publishing', () => {
  const commands = () => db.select().from(schema.operations);

  it('an ACTIVE voucher waits for the chain and takes the current refund policy into its promise', async () => {
    const voucher = await draft();
    expect(voucher).toMatchObject({
      status: 'DRAFT',
      publishStatus: 'PUBLISHING',
      refundPolicySnapshot: DEFAULT_VOUCHER_REFUND_POLICY,
    });
    expect(await commands()).toMatchObject([
      { commandType: 'VOUCHER_TERMS_PUBLISH', status: 'PENDING', payload: { voucherId: voucher.id } },
    ]);
    await expect(claim(voucher.id)).rejects.toThrow(/not active/);

    await repo.markVoucherPublished(voucher.id, '0xterms');
    expect(await row(voucher.id)).toMatchObject({
      status: 'ACTIVE',
      publishStatus: 'PUBLISHED',
      suiTermsId: '0xterms',
    });
    expect((await claim(voucher.id)).refundPolicy).toEqual(DEFAULT_VOUCHER_REFUND_POLICY);
  });

  it('a voucher created as a draft or paused stays off-chain and fully editable', async () => {
    const voucher = await draft({ status: 'DRAFT' });
    expect(voucher.publishStatus).toBe('NOT_PUBLISHED');
    expect(await commands()).toEqual([]);
    expect((await repo.updateVoucher(orgId, voucher.id, { title: 'Renamed', pointsCost: 5 }, () => {})).title).toBe(
      'Renamed',
    );
    await expect(claim(voucher.id)).rejects.toThrow(/not active/);
  });

  it('activating publishes first; a failed publish can be edited and activated again', async () => {
    const voucher = await draft({ status: 'PAUSED' });
    const publishing = await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE', title: 'Final' }, () => {});
    expect(publishing).toMatchObject({ status: 'DRAFT', publishStatus: 'PUBLISHING', title: 'Final' });

    await repo.failVoucherPublish(voucher.id);
    expect(await row(voucher.id)).toMatchObject({ status: 'DRAFT', publishStatus: 'FAILED' });
    await repo.updateVoucher(orgId, voucher.id, { title: 'Corrected' }, () => {});

    const retried = await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {});
    expect(retried.publishStatus).toBe('PUBLISHING');
    expect(await commands()).toHaveLength(2);
    await repo.markVoucherPublished(voucher.id, '0xterms');
    expect(await row(voucher.id)).toMatchObject({ status: 'ACTIVE', title: 'Corrected' });
  });

  it('a repeat activation queues nothing, and a pause during publishing survives the confirmation', async () => {
    const voucher = await draft();
    expect((await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).status).toBe('DRAFT');
    expect(await commands()).toHaveLength(1);
    await repo.updateVoucher(orgId, voucher.id, { status: 'PAUSED' }, () => {});
    await repo.markVoucherPublished(voucher.id, '0xterms');
    expect(await row(voucher.id)).toMatchObject({ status: 'PAUSED', publishStatus: 'PUBLISHED' });
    expect((await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).status).toBe('ACTIVE');
    expect(await commands()).toHaveLength(1);
  });

  it.each([
    ['title', { title: 'Changed' }],
    ['description', { description: 'Changed' }],
    ['pointsCost', { pointsCost: 99 }],
    ['terms', { terms: { fine: 'print' } }],
    ['expiresAt', { expiresAt: new Date('2099-01-01T00:00:00Z') }],
  ] as const)('freezes %s from the moment publishing starts', async (field, patch) => {
    const voucher = await draft();
    await expect(repo.updateVoucher(orgId, voucher.id, patch, () => {})).rejects.toThrow(
      new RegExp(`${field} cannot change`),
    );
    await repo.markVoucherPublished(voucher.id, '0xterms');
    await expect(repo.updateVoucher(orgId, voucher.id, patch, () => {})).rejects.toThrow(
      new RegExp(`${field} cannot change`),
    );
  });

  it('supply and metadata stay editable after publishing', async () => {
    const voucher = await create({ terms: { fine: 'print' } });
    const updated = await repo.updateVoucher(
      orgId,
      voucher.id,
      { totalSupply: 10, metadata: { campaign: 'tet' }, terms: { fine: 'print' } },
      () => {},
    );
    expect(updated).toMatchObject({ totalSupply: 10, metadata: { campaign: 'tet' } });
  });

  it('a policy published later does not change a voucher that already published its own', async () => {
    const policies = new VoucherRefundPoliciesRepository(db);
    const voucher = await create();
    const { credential } = await seedCredential(db, orgId);
    await policies.publish(orgId, credential.id, {
      allowUnused: false,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: null,
      reason: 'Stricter terms',
    });
    expect((await claim(voucher.id)).refundPolicy).toEqual(DEFAULT_VOUCHER_REFUND_POLICY);
  });
});

describe('granted vouchers', () => {
  const grant = (voucherId: string, key = 'grant-1', member = memberId) =>
    repo.claimVoucher(orgId, voucherId, member, key, { grant: true });

  it('reserves stock without touching points, and the chain makes it available exactly once', async () => {
    const voucher = await create({ pointsCost: 25, totalSupply: 1 });
    await db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://example.com/hook', secret: 'test-secret' });
    const granted = await grant(voucher.id);
    expect(granted).toMatchObject({ status: 'RESERVED', pointsCost: 0, pointsDeducted: 0, transactionId: null });
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 0 });
    expect(await db.select().from(schema.operations)).toMatchObject([
      { commandType: 'VOUCHER_GRANT', status: 'PENDING', payload: { voucherOwnershipId: granted.voucherOwnershipId } },
    ]);
    await expect(use(granted.serialCode)).rejects.toThrow(/RESERVED/);

    const params = { voucherOwnershipId: granted.voucherOwnershipId, digest: 'grant-digest' };
    expect((await repo.confirmVoucherGrant(params))?.key).toMatchObject({ idempotencyKey: 'grant-1' });
    expect(await repo.confirmVoucherGrant(params)).toBeNull();
    expect(await repo.getClaim(orgId, granted.voucherOwnershipId)).toMatchObject({ status: 'AVAILABLE' });
    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries).toMatchObject([
      { eventType: 'voucher.granted', payload: { status: 'AVAILABLE', blockchainDigest: 'grant-digest' } },
    ]);
    expect((await use(granted.serialCode)).ownership.status).toBe('REDEEMED');
  });

  it('a failed grant cancels the voucher and returns its unit, and a late confirmation changes nothing', async () => {
    const voucher = await create({ totalSupply: 1 });
    const granted = await grant(voucher.id);
    expect(await row(voucher.id)).toMatchObject({ status: 'DEPLETED', claimedCount: 1 });
    await repo.failVoucherGrant(granted.voucherOwnershipId);
    await repo.failVoucherGrant(granted.voucherOwnershipId);
    expect(await repo.getClaim(orgId, granted.voucherOwnershipId)).toMatchObject({ status: 'CANCELLED' });
    expect(await row(voucher.id)).toMatchObject({ status: 'ACTIVE', claimedCount: 0 });
    expect(
      await repo.confirmVoucherGrant({ voucherOwnershipId: granted.voucherOwnershipId, digest: 'late' }),
    ).toBeNull();
  });

  it('a retry reports the same grant, and a key cannot switch between a grant and a claim', async () => {
    const voucher = await create();
    const granted = await grant(voucher.id);
    expect(await grant(voucher.id)).toEqual(granted);
    await expect(claim(voucher.id, 'grant-1')).rejects.toThrow(/different payload/);
    await expect(grant(voucher.id, 'grant-2')).rejects.toThrow(/already been claimed/);
  });

  it('cannot be refunded: there is no REDEEM transaction, and nothing was paid', async () => {
    const granted = await grant((await create()).id);
    await repo.confirmVoucherGrant({ voucherOwnershipId: granted.voucherOwnershipId, digest: 'grant-digest' });
    expect((await repo.getClaim(orgId, granted.voucherOwnershipId)).transactionId).toBeNull();
  });
});

describe('customer-signed voucher use', () => {
  let issuedCount = 0;
  const issued = async (overrides = {}) =>
    confirm(await claim((await create(overrides)).id, `issued-${++issuedCount}`));
  const reserve = (serialCode: string, idempotencyKey = 'use-key') =>
    repo.reserveVoucherUse({ organizationId: orgId, serialCode, idempotencyKey });

  it('accepting a use changes nothing the customer owns', async () => {
    const coupon = await issued();
    const { ownership, isNew, operation } = await reserve(coupon.serialCode);
    expect(isNew).toBe(true);
    expect(operation).toMatchObject({ commandType: 'VOUCHER_USE_RESERVE', status: 'PENDING' });
    expect(ownership.status).toBe('AVAILABLE');
    expect((await repo.getClaim(orgId, coupon.voucherOwnershipId)).status).toBe('AVAILABLE');
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(0);
  });

  it('a retry resumes the same use and refreshes its age; another key is refused until it settles', async () => {
    const coupon = await issued();
    const first = await reserve(coupon.serialCode);
    await db.update(schema.operations).set({ updatedAt: new Date(Date.now() - 31 * 60 * 1000) });
    const retry = await reserve(coupon.serialCode);
    expect(retry).toMatchObject({ isNew: false, operation: { id: first.operation.id } });
    const [refreshed] = await db.select().from(schema.operations).where(eq(schema.operations.id, first.operation.id));
    expect(refreshed.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    await expect(reserve(coupon.serialCode, 'other-key')).rejects.toMatchObject({ kind: 'CONFLICT' });
  });

  it('a key used for another voucher conflicts', async () => {
    const first = await issued();
    const second = await issued({ code: 'SECOND', pointsCost: 10 });
    await reserve(first.serialCode);
    await expect(reserve(second.serialCode)).rejects.toThrow(/different payload/);
  });

  it('confirming marks it used once, queues one webhook and reports the command to settle', async () => {
    const coupon = await issued();
    await db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://example.com/hook', secret: 'test-secret' });
    const { ownership } = await reserve(coupon.serialCode);
    const params = { voucherOwnershipId: ownership.id, digest: 'use-digest' };
    const first = await repo.confirmVoucherUse(params);
    expect(first).toMatchObject({
      applied: true,
      ownership: { status: 'REDEEMED', pendingOperationId: null },
      key: { idempotencyKey: 'use-key' },
    });
    expect(await repo.confirmVoucherUse(params)).toMatchObject({ applied: false, key: null });
    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries).toMatchObject([
      { eventType: 'voucher.redeemed', payload: { status: 'REDEEMED', blockchainDigest: 'use-digest' } },
    ]);
  });

  it('follows the chain for a use with no command behind it, but never revives a cancelled voucher', async () => {
    const coupon = await issued();
    const applied = await repo.confirmVoucherUse({ voucherOwnershipId: coupon.voucherOwnershipId, digest: 'direct' });
    expect(applied).toMatchObject({ applied: true, key: null, ownership: { status: 'REDEEMED' } });

    const refunded = await issued({ code: 'REFUNDED', pointsCost: 10 });
    await credits.recordReversalTransaction({
      evaluateRefund: evaluateVoucherRefund,
      organizationId: orgId,
      original: (await credits.getLoyaltyTransactionById(refunded.transactionId!))!,
      idempotencyKey: 'refund',
      reason: 'refund',
    });
    expect(
      await repo.confirmVoucherUse({ voucherOwnershipId: refunded.voucherOwnershipId, digest: 'late' }),
    ).toBeNull();
    expect((await repo.getClaim(orgId, refunded.voucherOwnershipId)).status).toBe('CANCELLED');
    expect(await repo.confirmVoucherUse({ voucherOwnershipId: crypto.randomUUID(), digest: 'unknown' })).toBeNull();
  });

  it('a refund is refused while a use is in flight, and allowed again once it ends unsigned', async () => {
    const coupon = await issued();
    const original = (await credits.getLoyaltyTransactionById(coupon.transactionId!))!;
    const refund = (idempotencyKey: string) =>
      credits.recordReversalTransaction({
        evaluateRefund: evaluateVoucherRefund,
        organizationId: orgId,
        original,
        idempotencyKey,
        reason: 'refund',
      });
    const { operation } = await reserve(coupon.serialCode);
    await expect(refund('refund-1')).rejects.toThrow(/still in progress/);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);

    expect(
      await repo.failVoucherUse({
        operationId: operation.id,
        voucherOwnershipId: coupon.voucherOwnershipId,
        onlyIfUnsubmitted: true,
      }),
    ).toBe(true);
    await refund('refund-2');
    expect((await repo.getClaim(orgId, coupon.voucherOwnershipId)).status).toBe('CANCELLED');
    await expect(reserve(coupon.serialCode, 'after-refund')).rejects.toThrow(/CANCELLED/);
  });

  it('abandonment yields to a finalize that pinned a digest', async () => {
    const coupon = await issued();
    const { operation } = await reserve(coupon.serialCode);
    await db.update(schema.operations).set({ suiTxDigest: 'pinned' }).where(eq(schema.operations.id, operation.id));
    const params = { operationId: operation.id, voucherOwnershipId: coupon.voucherOwnershipId };
    expect(await repo.failVoucherUse({ ...params, onlyIfUnsubmitted: true })).toBe(false);
    expect(await repo.failVoucherUse(params)).toBe(true);
    expect(await repo.failVoucherUse({ ...params, operationId: crypto.randomUUID() })).toBe(false);
  });

  it('refuses a voucher that has no on-chain record, and a blocked member', async () => {
    const coupon = await issued();
    await db.update(schema.vouchers).set({ suiTermsId: null }).where(eq(schema.vouchers.id, coupon.voucherId));
    await expect(reserve(coupon.serialCode)).rejects.toThrow(/no on-chain record/);
    await db.update(schema.vouchers).set({ suiTermsId: '0xterms' }).where(eq(schema.vouchers.id, coupon.voucherId));
    await db
      .update(schema.organizationEndUsers)
      .set({ status: 'BLOCKED' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    await expect(reserve(coupon.serialCode)).rejects.toThrow(/Member is not active/);
    await expect(reserve('NO-SUCH-SERIAL')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('a key already used by another command conflicts', async () => {
    const coupon = await issued();
    await db.insert(schema.operations).values({
      tenantId: orgId,
      idempotencyKey: 'earn-key',
      commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
      payload: {},
    });
    await expect(reserve(coupon.serialCode, 'earn-key')).rejects.toThrow(/different payload/);
  });
});

describe('voucher redeem outbox retained from OCT-244', () => {
  it('concurrent serial uses announce exactly one voucher.redeemed in the same transaction', async () => {
    const result = await confirm(await claim((await create()).id));
    await db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://example.com/hook', secret: 'test' });
    const attempts = await Promise.allSettled([use(result.serialCode), use(result.serialCode)]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const delivered = await db.select().from(schema.webhookDeliveries);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      eventType: 'voucher.redeemed',
      payload: {
        voucherOwnershipId: result.voucherOwnershipId,
        voucherId: result.voucherId,
        organizationEndUserId: memberId,
        serialCode: result.serialCode,
        status: 'REDEEMED',
        voucherTitle: 'Coffee',
        discountType: 'FREE_ITEM',
        discountValue: null,
      },
    });
    expect((delivered[0].payload as Record<string, unknown>).redeemedAt).toEqual(expect.any(String));
  });
});

describe('organization refund policy snapshots', () => {
  const policies = new VoucherRefundPoliciesRepository(db);
  const publish = async (changes: Partial<Omit<typeof DEFAULT_VOUCHER_REFUND_POLICY, 'version'>>) => {
    const defaults = {
      allowUnused: true,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: null as number | null,
    };
    const { credential } = await seedCredential(db, orgId);
    const settings = { ...defaults, ...changes };
    return policies.publish(orgId, credential.id, { ...settings, reason: 'Merchant refund terms' });
  };
  const reverse = async (result: Awaited<ReturnType<typeof confirm>>, key: string) =>
    credits.recordReversalTransaction({
      organizationId: orgId,
      original: (await credits.getLoyaltyTransactionById(result.transactionId!))!,
      idempotencyKey: key,
      reason: 'Customer refund',
      evaluateRefund: evaluateVoucherRefund,
    });

  it('keeps existing terms when the merchant disables unused refunds for future claims', async () => {
    const old = await confirm(await claim((await create()).id));
    expect(old.refundPolicy).toEqual(DEFAULT_VOUCHER_REFUND_POLICY);
    await publish({ allowUnused: false });
    const next = await confirm(await claim((await create({ code: 'NEW' })).id, 'new-claim'));
    expect(next.refundPolicy).toMatchObject({ version: 1, allowUnused: false });
    await reverse(old, 'old-refund');
    await expect(reverse(next, 'new-refund')).rejects.toThrow(/Unused coupon refunds are disabled/);
    expect((await repo.getClaim(orgId, old.voucherOwnershipId)).status).toBe('CANCELLED');
    expect((await repo.getClaim(orgId, next.voucherOwnershipId)).status).toBe('AVAILABLE');
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
  });

  it('refunds redeemed coupons only when permitted, retaining usage and never returning stock', async () => {
    await publish({ allowRedeemed: true });
    const voucher = await create({ totalSupply: 1 });
    const issued = await confirm(await claim(voucher.id));
    await use(issued.serialCode);
    const result = await reverse(issued, 'used-refund');
    expect(result.newBalance).toBe(100);
    expect(result.reversal.metadata).toMatchObject({
      voucherRefund: { policy: { version: 1, allowRedeemed: true }, couponStatus: 'REDEEMED', restocked: false },
    });
    expect((await repo.getClaim(orgId, issued.voucherOwnershipId)).status).toBe('REDEEMED');
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    await expect(reverse(issued, 'second-refund')).rejects.toThrow();
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
  });

  it.each(['EXPIRED', 'AVAILABLE'] as const)(
    'can refund an expired %s coupon without restoring its benefit',
    async (status) => {
      await publish({ allowExpired: true });
      const voucher = await create({ totalSupply: 1 });
      const issued = await confirm(await claim(voucher.id));
      await db
        .update(schema.voucherOwnerships)
        .set({ status, expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.voucherOwnerships.id, issued.voucherOwnershipId));
      await reverse(issued, 'expired-refund');
      expect((await repo.getClaim(orgId, issued.voucherOwnershipId)).status).toBe('EXPIRED');
      expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
      expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
      await expect(use(issued.serialCode)).rejects.toThrow();
    },
  );

  it('can refund an unused coupon without restocking', async () => {
    await publish({ restockUnused: false });
    const voucher = await create({ totalSupply: 1 });
    const issued = await confirm(await claim(voucher.id));
    await reverse(issued, 'unused-refund');
    expect((await repo.getClaim(orgId, issued.voucherOwnershipId)).status).toBe('CANCELLED');
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
  });

  it('rejects refunds beyond the claim-time policy window without any writes', async () => {
    await publish({ refundWindowDays: 7 });
    const issued = await confirm(await claim((await create()).id));
    await db
      .update(schema.voucherOwnerships)
      .set({ claimedAt: new Date(Date.now() - 8 * 86400000) })
      .where(eq(schema.voucherOwnerships.id, issued.voucherOwnershipId));
    await expect(reverse(issued, 'late-refund')).rejects.toThrow(/refund window has ended/);
    expect((await repo.getClaim(orgId, issued.voucherOwnershipId)).status).toBe('AVAILABLE');
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
  });

  it('does not refund twice when an explicitly refundable used coupon is reversed concurrently', async () => {
    await publish({ allowRedeemed: true });
    const voucher = await create({ totalSupply: 1 });
    const issued = await confirm(await claim(voucher.id));
    await use(issued.serialCode);
    const outcomes = await Promise.allSettled([reverse(issued, 'refund-a'), reverse(issued, 'refund-b')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(100);
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    expect((await repo.getClaim(orgId, issued.voucherOwnershipId)).status).toBe('REDEEMED');
  });

  it('does not permit the application role to rewrite/delete history or read another tenant policy', async () => {
    await publish({ allowRedeemed: true });
    const foreign = await seedOrganization(db);
    await withRls(db, { tenantId: foreign.id }, async (tx) => {
      expect(await tx.select().from(schema.voucherRefundPolicies)).toEqual([]);
    });
    await withRls(db, { tenantId: orgId }, async (tx) => {
      expect(await tx.update(schema.voucherRefundPolicies).set({ reason: 'Tampered' }).returning()).toEqual([]);
      expect(await tx.delete(schema.voucherRefundPolicies).returning()).toEqual([]);
    });
    expect((await policies.history(orgId))[0]).toMatchObject({ version: 1, reason: 'Merchant refund terms' });
  });

  it('keeps the database baseline terms aligned with the public default policy', async () => {
    const voucher = await create({ pointsCost: 0 });
    const [issued] = await db
      .insert(schema.voucherOwnerships)
      .values({
        voucherId: voucher.id,
        organizationEndUserId: memberId,
        serialCode: 'DEFAULT-SNAPSHOT',
      })
      .returning();
    expect(issued.refundPolicySnapshot).toEqual(DEFAULT_VOUCHER_REFUND_POLICY);
  });

  it('retains the historical actor after a credential is removed', async () => {
    const published = await publish({ allowUnused: false });
    if (published.createdByCredentialId === null) throw new Error('Published policies require an actor');
    await db.delete(schema.apiCredentials).where(eq(schema.apiCredentials.id, published.createdByCredentialId));
    expect((await policies.current(orgId)).createdByCredentialId).toBe(published.createdByCredentialId);
    expect((await policies.history(orgId))[0].createdByCredentialId).toBe(published.createdByCredentialId);
  });

  it('cannot publish with a credential from another tenant', async () => {
    const other = await seedOrganization(db);
    const { credential } = await seedCredential(db, other.id);
    const settings = {
      allowUnused: true,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: null as number | null,
    };
    await expect(policies.publish(orgId, credential.id, { ...settings, reason: 'Foreign change' })).rejects.toThrow();
    expect(await policies.history(orgId)).toEqual([]);
  });
});
