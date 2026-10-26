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
    ).toBe(75);
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
      pointsDeducted: 60,
      status: 'AVAILABLE',
      serialCode: expect.stringMatching(/^COFFEE-[0-9A-F]{16}$/),
    });
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
