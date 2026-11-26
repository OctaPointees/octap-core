import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { createTestApp } from '../support/app.js';
import { insertLoyaltyTransaction, resetDb, schema, seedMember, seedOrganization } from '../support/db.js';

const ACTORS = ['owner', 'developer', 'stranger'] as const;
type Actor = (typeof ACTORS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_FROM = new Date('2026-11-01T00:00:00Z');
const WINDOW_TO = new Date('2026-11-04T00:00:00Z');
const day = (n: number, hour: number) => new Date(WINDOW_FROM.getTime() + n * DAY_MS + hour * 60 * 60 * 1000);

describe('program analytics: how points and vouchers actually moved, for Owner and Business Developer', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let alice: string;
  let bob: string;
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
  const summary = (actor: Actor, query: Record<string, string> = {}) =>
    ctx.http().get(`/v1/console/organizations/${orgId}/analytics/summary`).query(query).set(as(actor));

  async function claimVoucher(ownerMemberId: string, overrides: Partial<typeof schema.voucherOwnerships.$inferInsert>) {
    const [voucher] = await ctx.db
      .insert(schema.vouchers)
      .values({ organizationId: orgId, code: `V-${randomUUID()}`, title: 'Test voucher' })
      .returning();
    return ctx.db
      .insert(schema.voucherOwnerships)
      .values({
        voucherId: voucher.id,
        organizationEndUserId: ownerMemberId,
        serialCode: `S-${randomUUID()}`,
        ...overrides,
      })
      .returning();
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
    alice = (await seedMember(ctx.db, orgId)).memberId;
    bob = (await seedMember(ctx.db, orgId)).memberId;
    await seedMember(ctx.db, orgId); // carol: enrolled, never transacts
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

  it('sums circulation CONFIRMED-only, counts active vs enrolled members, and buckets the trend by day', async () => {
    // Inside the window: counts.
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: alice,
      transactionType: 'EARN',
      pointsAmount: 100,
      idempotencyKey: 'earn-alice',
      status: 'CONFIRMED',
      createdAt: day(0, 1),
    });
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: bob,
      transactionType: 'EARN',
      pointsAmount: 50,
      idempotencyKey: 'earn-bob',
      status: 'CONFIRMED',
      createdAt: day(1, 1),
    });
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: alice,
      transactionType: 'REDEEM',
      pointsAmount: 30,
      idempotencyKey: 'redeem-alice',
      status: 'CONFIRMED',
      createdAt: day(1, 2),
    });
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: alice,
      transactionType: 'REVERSAL',
      pointsAmount: 10,
      idempotencyKey: 'reversal-alice',
      status: 'CONFIRMED',
      createdAt: day(2, 1),
    });
    // Outside what counts: PENDING (not yet real) and before the window.
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: bob,
      transactionType: 'EARN',
      pointsAmount: 999,
      idempotencyKey: 'earn-bob-pending',
      status: 'PENDING',
      createdAt: day(0, 1),
    });
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: orgId,
      organizationEndUserId: alice,
      transactionType: 'EARN',
      pointsAmount: 500,
      idempotencyKey: 'earn-alice-before',
      status: 'CONFIRMED',
      createdAt: new Date(WINDOW_FROM.getTime() - DAY_MS),
    });

    const body = (await summary('owner', { from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() }).expect(200))
      .body;

    expect(body).toMatchObject({
      from: WINDOW_FROM.toISOString(),
      to: WINDOW_TO.toISOString(),
      circulation: { earned: 150, redeemed: 30, reversed: 10, net: 110 },
      engagement: { activeMembers: 2, enrolledMembers: 3 },
    });
    expect(body.dailyTrend).toEqual([
      { start: day(0, 0).toISOString(), earned: 100, redeemed: 0 },
      { start: day(1, 0).toISOString(), earned: 50, redeemed: 30 },
      { start: day(2, 0).toISOString(), earned: 0, redeemed: 0 },
    ]);

    expect(
      (await summary('developer', { from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() }).expect(200)).body,
    ).toMatchObject({ circulation: { earned: 150 } });
    await summary('stranger').expect(403);
  });

  it('counts a voucher as claimed by when it was claimed, redeemed or expired by their own timestamp', async () => {
    // Claimed and redeemed in the window: counts for both.
    const [used] = await claimVoucher(alice, {
      claimedAt: day(0, 3),
      status: 'REDEEMED',
      redeemedAt: day(1, 3),
    });
    // Claimed in the window, then expired unused in the window.
    const [expired] = await claimVoucher(bob, {
      claimedAt: day(1, 4),
      status: 'EXPIRED',
      expiresAt: day(2, 4),
    });
    // Claimed in the window, still sitting unused — counts as claimed only.
    await claimVoucher(alice, { claimedAt: day(2, 5) });
    // Claimed before the window: does not count.
    await claimVoucher(bob, { claimedAt: new Date(WINDOW_FROM.getTime() - DAY_MS) });

    const body = (await summary('owner', { from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() }).expect(200))
      .body;
    expect(body.vouchers).toEqual({ claimed: 3, redeemed: 1, expiredUnused: 1 });
    expect(used.status).toBe('REDEEMED');
    expect(expired.status).toBe('EXPIRED');
  });

  it('defaults to the last 30 days when from/to are omitted, and validates the range', async () => {
    const body = (await summary('owner').expect(200)).body;
    const spanDays = (new Date(body.to).getTime() - new Date(body.from).getTime()) / DAY_MS;
    expect(spanDays).toBeCloseTo(30, 1);

    await summary('owner', { from: WINDOW_TO.toISOString(), to: WINDOW_FROM.toISOString() }).expect(400);
    await summary('owner', { from: 'not-a-date', to: WINDOW_TO.toISOString() }).expect(400);
    await summary('owner', { bogus: 'x' } as unknown as Record<string, string>).expect(400);
  });
});
