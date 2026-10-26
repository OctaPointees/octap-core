import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import {
  connectTestDb,
  resetDb,
  schema,
  seedMember,
  seedOrganization,
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
  await setOwnership(db, memberId, { confirmedBalance: 100, lifetimeEarned: 100 });
});
afterAll(() => client.end());
const create = (overrides: Partial<Parameters<RewardsRepository['createVoucher']>[0]> = {}) =>
  repo.createVoucher({
    organizationId: orgId,
    code: 'COFFEE',
    title: 'Coffee',
    discountType: 'FREE_ITEM',
    pointsCost: 25,
    ...overrides,
  });
const claim = (voucherId: string, key = 'claim-1', member = memberId) =>
  repo.claimVoucher(orgId, voucherId, member, key);
const row = async (id: string) => (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)))[0];

describe('atomic voucher conversion', () => {
  it('returns a conflict when the same voucher code is created concurrently', async () => {
    const results = await Promise.allSettled([create(), create(), create()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
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
    expect(result).toMatchObject({ pointsDeducted: 25, status: 'AVAILABLE' });
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
    expect(await row(voucher.id)).toMatchObject({ claimedCount: 1, status: 'DEPLETED' });
    expect(await claim(voucher.id)).toEqual(result);
    await repo.redeemVoucher(orgId, result.serialCode);
    expect(await claim(voucher.id)).toEqual(result);
    expect(await db.select().from(schema.loyaltyTransactions)).toHaveLength(1);
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(1);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(1);
  });

  it('serializes simultaneous retries of one key and rejects changed payloads', async () => {
    const voucher = await create();
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(voucher.id)));
    expect(results.every((result) => result.voucherOwnershipId === results[0].voucherOwnershipId)).toBe(true);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
    const other = await create({ code: 'OTHER' });
    await expect(claim(other.id)).rejects.toMatchObject({ status: 409 });
    const second = (await seedMember(db, orgId)).memberId;
    await expect(claim(voucher.id, 'claim-1', second)).rejects.toMatchObject({ status: 409 });
  });

  it('does not deduct points for another key after a member already claimed', async () => {
    const voucher = await create();
    await claim(voucher.id);
    await expect(claim(voucher.id, 'claim-2')).rejects.toThrow(/already been claimed/);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
    expect(await db.select().from(schema.operations)).toHaveLength(1);
  });

  it('cannot oversell the final unit to two different members', async () => {
    const voucher = await create({ totalSupply: 1 });
    const second = (await seedMember(db, orgId)).memberId;
    await setOwnership(db, second, { confirmedBalance: 100 });
    const results = await Promise.allSettled([claim(voucher.id), claim(voucher.id, 'claim-2', second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(schema.voucherOwnerships)).toHaveLength(1);
    expect(
      (await getOwnership(db, memberId)).confirmedBalance + (await getOwnership(db, second)).confirmedBalance,
    ).toBe(175);
    expect((await row(voucher.id)).claimedCount).toBe(1);
  });

  it('cannot overspend a shared balance when different rewards are claimed concurrently', async () => {
    const first = await create({ pointsCost: 60 });
    const second = await create({ code: 'OTHER', pointsCost: 60 });
    const results = await Promise.allSettled([claim(first.id), claim(second.id, 'claim-2')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(40);
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
    expect((await claim(voucher.id)).pointsDeducted).toBe(25);
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
    await claim(voucher.id);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(10);
    expect((await db.select().from(schema.creditBuckets)).reduce((sum, bucket) => sum + bucket.remaining, 0)).toBe(10);
  });

  it('enforces organization and member eligibility even for free rewards', async () => {
    const voucher = await create({ pointsCost: 0 });
    const other = await seedOrganization(db);
    await expect(repo.claimVoucher(other.id, voucher.id, memberId, 'other-key')).rejects.toMatchObject({ status: 404 });
    const foreignMember = (await seedMember(db, other.id)).memberId;
    await expect(claim(voucher.id, 'foreign-key', foreignMember)).rejects.toMatchObject({ status: 404 });
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

  it('supports free reward replay without a points debit and rejects keys owned by other commands', async () => {
    const voucher = await create({ pointsCost: 0 });
    const result = await claim(voucher.id);
    expect(await claim(voucher.id)).toEqual(result);
    expect(await db.select().from(schema.loyaltyTransactions)).toHaveLength(0);
    const second = await create({ code: 'SECOND' });
    await db
      .insert(schema.operations)
      .values({ tenantId: orgId, idempotencyKey: 'earn-key', commandType: 'CREDIT_EARN_CHAIN_SUBMIT', payload: {} });
    await expect(claim(second.id, 'earn-key')).rejects.toMatchObject({ status: 409 });
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
      status: 409,
    });
  });

  it('does not activate expired rewards or reduce stock below claimed supply', async () => {
    const expired = await create({ code: 'EXPIRED', status: 'DRAFT', expiresAt: new Date(Date.now() - 1000) });
    await expect(repo.updateVoucher(orgId, expired.id, { status: 'ACTIVE' }, () => {})).rejects.toMatchObject({
      status: 400,
    });
    const voucher = await create({ totalSupply: 2 });
    await claim(voucher.id);
    await expect(repo.updateVoucher(orgId, voucher.id, { totalSupply: 0 }, () => {})).rejects.toMatchObject({
      status: 409,
    });
    await repo.updateVoucher(orgId, voucher.id, { totalSupply: 1 }, () => {});
    await expect(repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).rejects.toMatchObject({
      status: 409,
    });
    const restocked = await repo.updateVoucher(orgId, voucher.id, { totalSupply: 2 }, () => {});
    expect(restocked.status).toBe('DEPLETED');
    expect((await repo.updateVoucher(orgId, voucher.id, { status: 'ACTIVE' }, () => {})).status).toBe('ACTIVE');
  });

  it('allows only one simultaneous redemption and rejects foreign organizations', async () => {
    const voucher = await create();
    const result = await claim(voucher.id);
    const other = await seedOrganization(db);
    await expect(repo.redeemVoucher(other.id, result.serialCode)).rejects.toMatchObject({ status: 404 });
    const results = await Promise.allSettled([
      repo.redeemVoucher(orgId, result.serialCode),
      repo.redeemVoucher(orgId, result.serialCode),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.findOwnershipBySerial(result.serialCode))?.status).toBe('REDEEMED');
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(75);
  });

  it('rejects expired ownership, preserves issued benefits when paused and freezes economic fields', async () => {
    const voucher = await create();
    const result = await claim(voucher.id);
    await expect(repo.updateVoucher(orgId, voucher.id, { pointsCost: 30 }, () => {})).rejects.toMatchObject({
      status: 409,
    });
    await repo.updateVoucher(orgId, voucher.id, { status: 'PAUSED' }, () => {});
    await db
      .update(schema.voucherOwnerships)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.voucherOwnerships.id, result.voucherOwnershipId));
    await expect(repo.redeemVoucher(orgId, result.serialCode)).rejects.toThrow(/expired/);
    await db
      .update(schema.voucherOwnerships)
      .set({ expiresAt: null })
      .where(eq(schema.voucherOwnerships.id, result.voucherOwnershipId));
    expect((await repo.redeemVoucher(orgId, result.serialCode)).ownership.status).toBe('REDEEMED');
  });
});
