import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';
import { resetDb, seedCredential, seedMember, seedOrganization, setOwnership } from '../support/db.js';

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
  await setOwnership(ctx.db, memberId, { confirmedBalance: 100 });
});

afterAll(async () => {
  await ctx.close();
});

const createVoucher = (body: Record<string, unknown>) => ctx.http().post('/v1/rewards/vouchers').set(auth).send(body);

describe('rewards over HTTP', () => {
  it('create -> list/get -> claim (deducting points) -> redeem the serial -> member’s vouchers', async () => {
    const created = await createVoucher({ code: 'coffee', title: 'Free coffee', discountType: 'FREE_ITEM', pointsCost: 60, totalSupply: 2 }).expect(201);
    expect(created.body).toMatchObject({ code: 'coffee', pointsCost: 60, status: 'ACTIVE', claimedCount: 0 });
    await createVoucher({ code: 'coffee', title: 'dup', discountType: 'FREE_ITEM' }).expect(400);

    expect((await ctx.http().get('/v1/rewards/vouchers').set(auth).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`/v1/rewards/vouchers/${created.body.id}`).set(auth).expect(200);

    const claimed = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${created.body.id}/claim`)
      .set(auth)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'claim-1' })
      .expect(201);
    expect(claimed.body).toMatchObject({ pointsDeducted: 60, status: 'AVAILABLE', serialCode: expect.stringMatching(/^COFFEE-[0-9A-F]{8}$/) });
    expect((await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body.confirmedBalance).toBe(40);

    // Same member again: refused by the per-member uniqueness rule.
    await ctx.http().post(`/v1/rewards/vouchers/${created.body.id}/claim`).set(auth).send({ organizationEndUserId: memberId, idempotencyKey: 'claim-2' }).expect(400);

    const redeemed = await ctx.http().post('/v1/rewards/vouchers/redeem').set(auth).send({ serialCode: claimed.body.serialCode }).expect(201);
    expect(redeemed.body).toMatchObject({ status: 'REDEEMED', voucherTitle: 'Free coffee', discountType: 'FREE_ITEM' });
    await ctx.http().post('/v1/rewards/vouchers/redeem').set(auth).send({ serialCode: claimed.body.serialCode }).expect(400);

    const mine = (await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(auth).expect(200)).body;
    expect(mine).toMatchObject([{ status: 'REDEEMED', voucher: { code: 'coffee' } }]);
  });

  it('a claim the member can’t afford is refused and changes nothing', async () => {
    const created = await createVoucher({ code: 'big', title: 'Big', discountType: 'FIXED_AMOUNT', pointsCost: 500 }).expect(201);

    await ctx.http().post(`/v1/rewards/vouchers/${created.body.id}/claim`).set(auth).send({ organizationEndUserId: memberId }).expect(400);

    expect((await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(auth).expect(200)).body).toEqual([]);
  });

  it('keeps tenants apart and validates bodies', async () => {
    const other = await seedOrganization(ctx.db);
    const otherAuth = { authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` };
    const created = await createVoucher({ code: 'mine', title: 'Mine', discountType: 'PERCENTAGE' }).expect(201);

    await ctx.http().get(`/v1/rewards/vouchers/${created.body.id}`).set(otherAuth).expect(404);
    await ctx.http().get(`/v1/rewards/members/${memberId}/vouchers`).set(otherAuth).expect(404);
    await createVoucher({ title: 'no code' }).expect(400);
    await ctx.http().post(`/v1/rewards/vouchers/${created.body.id}/claim`).set(auth).send({}).expect(400);
    await ctx.http().post('/v1/rewards/vouchers/redeem').set(auth).send({}).expect(400);
  });
});
