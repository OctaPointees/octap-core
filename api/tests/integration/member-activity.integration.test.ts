import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './support/app.js';
import { insertLoyaltyTransaction, resetDb, schema, seedMember, seedOrganization } from './support/db.js';

describe('console member transactions and vouchers', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let otherOrgId: string;
  let memberId: string;
  let otherMemberId: string;
  const bearer = (actor = 'owner') => `Bearer ${actor}`;
  const path = (org = orgId, member = memberId) => `/v1/console/organizations/${org}/members/${member}`;
  const get = (url: string, actor = 'owner') => ctx.http().get(url).set('Authorization', bearer(actor));

  beforeAll(async () => {
    ctx = await createTestApp(undefined, {
      verify: async (subject: string) => ({
        subject,
        email: `${subject}@example.com`,
        fullName: subject,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    for (const actor of ['owner', 'developer', 'outsider']) {
      const login = await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201);
      if (actor !== 'outsider')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: login.body.user.id,
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
    }
    memberId = (await seedMember(ctx.db, orgId)).member.id;
    otherMemberId = (await seedMember(ctx.db, otherOrgId)).member.id;
  });

  const seedTransactions = async () => {
    // Three rows share a timestamp, so the page boundary has to fall back to the id.
    const tie = new Date('2026-11-01T10:00:00.123Z');
    const rows = [
      { key: 'old', createdAt: new Date('2026-10-01T00:00:00Z'), status: 'CONFIRMED' as const },
      { key: 'tie-1', createdAt: tie, status: 'CONFIRMED' as const },
      { key: 'tie-2', createdAt: tie, status: 'PENDING' as const },
      { key: 'tie-3', createdAt: tie, status: 'CONFIRMED' as const },
      { key: 'new', createdAt: new Date('2026-11-10T00:00:00Z'), status: 'PENDING' as const },
    ];
    for (const row of rows)
      await insertLoyaltyTransaction(ctx.db, {
        organizationId: orgId,
        organizationEndUserId: memberId,
        transactionType: 'EARN',
        pointsAmount: 10,
        purchaseAmount: 1000,
        idempotencyKey: row.key,
        status: row.status,
        createdAt: row.createdAt,
      });
    await insertLoyaltyTransaction(ctx.db, {
      organizationId: otherOrgId,
      organizationEndUserId: otherMemberId,
      transactionType: 'EARN',
      pointsAmount: 99,
      idempotencyKey: 'other-org',
    });
  };

  it('pages a member history newest first without skipping or repeating rows', async () => {
    await seedTransactions();
    const seen: { idempotencyKey: string; status: string; createdAt: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await get(`${path()}/transactions${query}`, pages % 2 ? 'developer' : 'owner').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.map((row) => row.idempotencyKey)).toHaveLength(5);
    expect(new Set(seen.map((row) => row.idempotencyKey)).size).toBe(5);
    expect(seen[0].idempotencyKey).toBe('new');
    expect(seen.at(-1)!.idempotencyKey).toBe('old');
    const times = seen.map((row) => Date.parse(row.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Pending earns show the estimate, not the final amount.
    expect(seen[0]).toMatchObject({ status: 'PENDING', pointsAmount: null, estimatedPoints: 10 });
    expect(seen.at(-1)).toMatchObject({ status: 'CONFIRMED', pointsAmount: 10, estimatedPoints: null });

    const all = await get(`${path()}/transactions`).expect(200);
    expect(all.body.items).toHaveLength(5);
    expect(all.body.nextCursor).toBeNull();
  });

  it('rejects bad queries and a cursor from another member', async () => {
    await seedTransactions();
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=bad', 'status=PENDING'])
      await get(`${path()}/transactions?${query}`).expect(400);
    const foreign = await ctx.db.query.loyaltyTransactions.findFirst({
      where: (t, { eq }) => eq(t.organizationId, otherOrgId),
    });
    await get(`${path()}/transactions?cursor=${foreign!.id}`).expect(400);
    await get(`${path()}/transactions?cursor=00000000-0000-4000-8000-000000000000`).expect(400);
  });

  it("lists the member's vouchers with their status", async () => {
    const [voucher] = await ctx.db
      .insert(schema.vouchers)
      .values({
        organizationId: orgId,
        code: 'WELCOME',
        title: 'Welcome',
        discountType: 'PERCENTAGE',
        discountValue: '10',
      })
      .returning();
    await ctx.db.insert(schema.voucherOwnerships).values([
      { voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'WELCOME-0001', status: 'AVAILABLE' },
      { voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'WELCOME-0002', status: 'REDEEMED' },
    ]);
    for (const actor of ['owner', 'developer']) {
      const res = await get(`${path()}/vouchers`, actor).expect(200);
      expect(
        res.body.map((row: { serialCode: string; status: string }) => [row.serialCode, row.status]).sort(),
      ).toEqual([
        ['WELCOME-0001', 'AVAILABLE'],
        ['WELCOME-0002', 'REDEEMED'],
      ]);
      expect(res.body[0].voucher).toMatchObject({ code: 'WELCOME' });
    }
    const empty = await get(path(orgId, (await seedMember(ctx.db, orgId)).member.id) + '/vouchers').expect(200);
    expect(empty.body).toEqual([]);
  });

  it('keeps both routes inside the caller organization', async () => {
    for (const suffix of ['transactions', 'vouchers']) {
      await get(`${path()}/${suffix}`, 'outsider').expect(403);
      // A member of another organization is not found here, even by an Owner.
      await get(`${path(orgId, otherMemberId)}/${suffix}`).expect(404);
      await get(`${path(orgId, '00000000-0000-4000-8000-000000000000')}/${suffix}`).expect(404);
      // The caller holds no role in the other organization.
      await get(`${path(otherOrgId, otherMemberId)}/${suffix}`).expect(403);
      await get(`${path(orgId, 'not-a-uuid')}/${suffix}`).expect(400);
    }
  });
});
