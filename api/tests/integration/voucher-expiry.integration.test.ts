import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import {
  eventsOfType,
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
} from './support/db.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import { VoucherExpiryWorker } from '#domain/rewards/voucher-expiry.worker.js';

const HOUR_MS = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const ahead = (hours: number) => new Date(Date.now() + hours * HOUR_MS);

/** Vouchers become EXPIRED when their deadline passes: by the sweep, or before a read. */
describe('voucher expiry', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let memberId: string;
  let key: { Authorization: string };
  const rewards = () => ctx.app.get(RewardsRepository, { strict: false });
  const sweep = () => new VoucherExpiryWorker(rewards()).sweepOnce();

  async function voucher(values: Partial<typeof schema.vouchers.$inferInsert> = {}) {
    const [row] = await ctx.db
      .insert(schema.vouchers)
      .values({
        organizationId: orgId,
        code: `V-${randomUUID()}`,
        title: 'Coffee',
        discountType: 'FREE_ITEM',
        pointsCost: 100,
        status: 'ACTIVE',
        ...values,
      })
      .returning();
    return row;
  }
  async function held(voucherId: string, values: Partial<typeof schema.voucherOwnerships.$inferInsert> = {}) {
    const [row] = await ctx.db
      .insert(schema.voucherOwnerships)
      .values({ voucherId, organizationEndUserId: memberId, serialCode: `S-${randomUUID()}`, ...values })
      .returning();
    return row;
  }
  const ownershipStatus = async (id: string) =>
    (await ctx.db.select().from(schema.voucherOwnerships).where(eq(schema.voucherOwnerships.id, id)))[0].status;
  const voucherStatus = async (id: string) =>
    (await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)))[0].status;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    memberId = (await seedMember(ctx.db, orgId)).memberId;
    key = { Authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
  });

  it('expires only what is past its deadline, sends one event each, and changes nothing on a second run', async () => {
    // The claim window has to stay open for the customers' vouchers to be about their own deadline.
    const open = await voucher({ expiresAt: ahead(48) });
    const lapsed = await held(open.id, { expiresAt: ago(1) });
    const current = await held(open.id, { expiresAt: ahead(1) });
    const forever = await held(open.id, { expiresAt: null });
    const inUse = await held(open.id, { status: 'RESERVED', expiresAt: ago(1) }); // the chain decides
    const used = await held(open.id, { status: 'REDEEMED', expiresAt: ago(1) });
    const live = await voucher({ expiresAt: ago(1) });
    const paused = await voucher({ status: 'PAUSED', expiresAt: ago(1) });
    const soldOut = await voucher({ status: 'DEPLETED', expiresAt: ago(1) });
    const draft = await voucher({ status: 'DRAFT', expiresAt: ago(1) });
    const waiting = await voucher({ status: 'PENDING_APPROVAL', expiresAt: ago(1) });

    expect(await sweep()).toEqual({ vouchers: 3, memberVouchers: 1 });

    expect(await ownershipStatus(lapsed.id)).toBe('EXPIRED');
    for (const [row, status] of [
      [current, 'AVAILABLE'],
      [forever, 'AVAILABLE'],
      [inUse, 'RESERVED'],
      [used, 'REDEEMED'],
    ] as const)
      expect(await ownershipStatus(row.id)).toBe(status);
    for (const row of [live, paused, soldOut]) expect(await voucherStatus(row.id)).toBe('EXPIRED');
    expect(await voucherStatus(draft.id)).toBe('DRAFT');
    expect(await voucherStatus(waiting.id)).toBe('PENDING_APPROVAL');
    expect(await voucherStatus(open.id)).toBe('ACTIVE');

    const memberEvents = await eventsOfType(ctx.db, 'voucher.member_expired');
    expect(memberEvents).toHaveLength(1);
    expect(memberEvents[0]).toMatchObject({
      organizationId: orgId,
      payload: {
        voucherOwnershipId: lapsed.id,
        voucherId: open.id,
        organizationEndUserId: memberId,
        serialCode: lapsed.serialCode,
        status: 'EXPIRED',
        expiresAt: lapsed.expiresAt!.toISOString(),
      },
    });
    const voucherEvents = await eventsOfType(ctx.db, 'voucher.expired');
    expect(voucherEvents.map((event) => (event.payload as { voucherId: string }).voucherId).sort()).toEqual(
      [live.id, paused.id, soldOut.id].sort(),
    );
    expect(voucherEvents.every((event) => (event.payload as { status: string }).status === 'EXPIRED')).toBe(true);

    expect(await sweep()).toEqual({ vouchers: 0, memberVouchers: 0 });
    expect(await eventsOfType(ctx.db, 'voucher.member_expired')).toHaveLength(1);
    expect(await eventsOfType(ctx.db, 'voucher.expired')).toHaveLength(3);
  });

  it('works through every batch in one sweep', async () => {
    const open = await voucher({ expiresAt: ahead(48) });
    for (let i = 0; i < 5; i += 1) await held(open.id, { expiresAt: ago(1) });
    expect(await rewards().expireDue(2)).toEqual({ vouchers: 0, memberVouchers: 2 });
    expect(await sweep()).toEqual({ vouchers: 0, memberVouchers: 3 });
  });

  it('expires before a read, so no read shows an expired voucher as usable, and never as the reader', async () => {
    const lapsedVoucher = await voucher({ expiresAt: ago(1) });
    const open = await voucher({ expiresAt: ahead(48) });
    const lapsed = await held(open.id, { expiresAt: ago(1) });

    const vouchers = (await ctx.http().get('/v1/rewards/vouchers').set(key).expect(200)).body as {
      id: string;
      status: string;
    }[];
    expect(vouchers.find((row) => row.id === lapsedVoucher.id)!.status).toBe('EXPIRED');
    const mine = (await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(key).expect(200)).body as {
      id: string;
      status: string;
    }[];
    expect(mine.find((row) => row.id === lapsed.id)!.status).toBe('EXPIRED');

    expect(await eventsOfType(ctx.db, 'voucher.member_expired')).toHaveLength(1);
    expect(await eventsOfType(ctx.db, 'voucher.expired')).toHaveLength(1);
    // The reader's key did not expire anything: the system did, so nothing is audited as theirs.
    const audited = await ctx.db.select().from(schema.auditLog);
    expect(audited.filter((row) => row.action.endsWith('expired'))).toEqual([]);
    expect(await sweep()).toEqual({ vouchers: 0, memberVouchers: 0 });
  });

  it('keeps an expired voucher EXPIRED: no status change, while supply stays editable', async () => {
    await seedProgram(ctx.db, orgId);
    const expired = await voucher({ status: 'EXPIRED', expiresAt: ago(1), totalSupply: 10, claimedCount: 10 });
    const patch = (body: Record<string, unknown>) =>
      ctx.http().patch(`/v1/rewards/vouchers/${expired.id}`).set(key).send(body);

    await patch({ status: 'PAUSED' }).expect(409);
    await patch({ status: 'ACTIVE' }).expect(409);
    // Fully claimed, which would otherwise make it DEPLETED.
    await patch({ totalSupply: 10 }).expect(200);
    expect(await voucherStatus(expired.id)).toBe('EXPIRED');
  });
});
