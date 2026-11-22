import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedCredential, seedOrganization, seedProgram } from './support/db.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';

const ACTORS = ['owner', 'developer', 'stranger', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const item = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  title: `Reward ${code}`,
  discountType: 'PERCENTAGE',
  discountValue: '20',
  pointsCost: 100,
  ...extra,
});

describe('voucher batches: create as DRAFT, compare by code, activate or archive together (OCT-303)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
  let key: { Authorization: string };
  let otherKey: { Authorization: string };
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
  const api = '/v1/rewards/voucher-batches';
  const consolePath = (org = orgId) => `/v1/console/organizations/${org}/voucher-batches`;
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const send = (body: Record<string, unknown>, auth = key) => ctx.http().post(api).set(auth).send(body);
  const activate = (batchId: string, auth = key) => ctx.http().post(`${api}/${batchId}/activate`).set(auth).send({});
  const archive = (batchId: string, auth = key) => ctx.http().post(`${api}/${batchId}/archive`).set(auth).send({});
  const voucherByCode = async (code: string) =>
    (await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.code, code)))[0];
  const requireApproval = () =>
    ctx
      .http()
      .patch(`/v1/console/organizations/${orgId}/settings`)
      .set(as('owner'))
      .send({ voucherApprovalRequired: true })
      .expect(200);

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    key = { Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
    otherKey = {
      Authorization: `Bearer ${(await seedCredential(ctx.db, otherOrgId, { scopes: ['read', 'write'] })).rawKey}`,
    };
  });

  it('refuses a bad request as a whole, and a read-only key', async () => {
    for (const [body, message] of [
      [{}, /items must be an array of 1 to 100/],
      [{ items: [] }, /items must be an array of 1 to 100/],
      [{ items: Array.from({ length: 101 }, (_, i) => item(`c${i}`)) }, /1 to 100/],
      [{ items: [item('a')], dryRun: 'yes' }, /dryRun must be a boolean/],
      [{ items: [item('a')], activate: true }, /unsupported fields/],
    ] as const) {
      expect((await send(body).expect(400)).body.message).toMatch(message);
    }
    const readOnly = {
      Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read'] })).rawKey}`,
    };
    await send({ items: [item('a')] }, readOnly).expect(403);
  });

  it('previews without writing, then creates a DRAFT batch with one result per item', async () => {
    const items = [
      item('A'),
      item('B', { pointsCost: -1 }),
      item('A'),
      item('C', { status: 'ACTIVE' }),
      { title: 'no code', discountType: 'FREE_ITEM' },
      item('D', { discountValue: '150' }),
    ];
    const preview = (await send({ items, dryRun: true }).expect(201)).body;
    expect(preview.dryRun).toBe(true);
    expect(preview.batch).toBeNull();
    expect(await ctx.db.select().from(schema.vouchers)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.voucherImportBatches)).toHaveLength(0);

    const created = (await send({ items }).expect(201)).body;
    expect(created.items).toEqual([
      { index: 0, code: 'A', status: 'created', voucherId: expect.any(String) },
      {
        index: 1,
        code: 'B',
        status: 'error',
        error: { code: 'INVALID', field: 'pointsCost', message: expect.stringMatching(/pointsCost must be/) },
      },
      {
        index: 2,
        code: 'A',
        status: 'error',
        error: { code: 'DUPLICATE_IN_BATCH', field: 'code', message: expect.any(String) },
      },
      {
        index: 3,
        code: 'C',
        status: 'error',
        error: { code: 'INVALID', field: 'status', message: expect.stringMatching(/always created as DRAFT/) },
      },
      { index: 4, code: null, status: 'error', error: expect.objectContaining({ code: 'INVALID', field: 'code' }) },
      { index: 5, code: 'D', status: 'error', error: expect.objectContaining({ field: 'discountValue' }) },
    ]);
    // The preview said the same, without an id.
    expect(preview.items.map((r: { status: string }) => r.status)).toEqual(
      created.items.map((r: { status: string }) => r.status),
    );
    expect(preview.items[0].voucherId).toBeNull();
    expect(created.batch).toMatchObject({
      organizationId: orgId,
      source: 'API',
      createdBy: { type: 'API_CREDENTIAL', id: expect.any(String) },
      archivedAt: null,
      statusCounts: { DRAFT: 1 },
    });
    const a = await voucherByCode('A');
    expect(a).toMatchObject({ status: 'DRAFT', publishStatus: 'NOT_PUBLISHED', importBatchId: created.batch.id });
    // A voucher shows its batch.
    expect((await ctx.http().get(`/v1/rewards/vouchers/${a.id}`).set(key).expect(200)).body.batchId).toBe(
      created.batch.id,
    );
  });

  it('makes sending the same list again safe, and keeps a code whose values changed', async () => {
    const first = (
      await send({
        items: [
          item('SALE', {
            discountValue: '20.00',
            startsAt: '2027-01-01T00:00:00.000Z',
            terms: { kind: 'PERCENT_OFF', cap: 50000 },
            metadata: { a: 1, b: 2 },
          }),
        ],
      }).expect(201)
    ).body;
    // The same values, spelled differently: another time zone, "20" (stored as "20.00"), keys in
    // another order.
    const again = (
      await send({
        items: [
          item('SALE', {
            discountValue: '20',
            startsAt: '2027-01-01T07:00:00+07:00',
            terms: { cap: 50000, kind: 'PERCENT_OFF' },
            metadata: { b: 2, a: 1 },
          }),
          item('NEW'),
        ],
      }).expect(201)
    ).body;
    expect(again.items[0]).toEqual({
      index: 0,
      code: 'SALE',
      status: 'unchanged',
      voucherId: first.items[0].voucherId,
      movedToBatch: false,
    });
    expect(again.items[1].status).toBe('created');

    const changed = (await send({ items: [item('SALE', { pointsCost: 300 })] }).expect(201)).body;
    expect(changed.items[0]).toMatchObject({
      status: 'conflict',
      differences: expect.arrayContaining([{ field: 'pointsCost', stored: 100, sent: 300 }]),
    });
    // Nothing landed in that call, so no empty batch was kept.
    expect(changed.batch).toBeNull();
    expect(await ctx.db.select().from(schema.voucherImportBatches)).toHaveLength(2);
    expect((await voucherByCode('SALE')).pointsCost).toBe(100);
  });

  it('never overwrites a live voucher or one created on its own', async () => {
    const single = (
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send({ ...item('SOLO'), status: 'DRAFT' })
        .expect(201)
    ).body;
    // A single create with a taken code is still a 409, not a 500.
    await ctx
      .http()
      .post('/v1/rewards/vouchers')
      .set(key)
      .send({ ...item('SOLO'), status: 'DRAFT' })
      .expect(409);

    const { batch } = (await send({ items: [item('LIVE')] }).expect(201)).body;
    await activate(batch.id).expect(201);
    const live = await voucherByCode('LIVE');
    await ctx.app.get(RewardsRepository).markVoucherPublished(live.id, '0xterms');
    await archive(batch.id).expect(201);

    const result = (
      await send({ items: [item('SOLO', { title: 'Other' }), item('LIVE', { title: 'Other' })] }).expect(201)
    ).body;
    expect(result.items.map((r: { status: string }) => r.status)).toEqual(['conflict', 'conflict']);
    expect(result.items[0].voucherId).toBe(single.id);
    // The live voucher of an archived batch keeps its code and its terms.
    expect(await voucherByCode('LIVE')).toMatchObject({
      title: 'Reward LIVE',
      status: 'ACTIVE',
      importBatchId: batch.id,
    });
  });

  it("archives a batch: hidden, can't be activated, and its drafts' codes go to the next batch", async () => {
    const old = (await send({ items: [item('KEEP'), item('EDIT')] }).expect(201)).body.batch;
    expect((await archive(old.id).expect(201)).body.archivedAt).toEqual(expect.any(String));
    // Archiving twice changes nothing.
    expect((await archive(old.id).expect(201)).body.archivedAt).toEqual(expect.any(String));
    expect((await activate(old.id).expect(409)).body.message).toMatch(/archived/);
    expect((await ctx.http().get(api).set(key).expect(200)).body).toHaveLength(0);
    expect((await ctx.http().get(`${api}?includeArchived=true`).set(key).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${api}?includeArchived=maybe`).set(key).expect(400);

    const next = (await send({ items: [item('KEEP'), item('EDIT', { pointsCost: 250 })] }).expect(201)).body;
    expect(next.items[0]).toMatchObject({ status: 'unchanged', movedToBatch: true });
    expect(next.items[1]).toMatchObject({
      status: 'replaced',
      differences: [{ field: 'pointsCost', stored: 100, sent: 250 }],
    });
    expect(next.batch.statusCounts).toEqual({ DRAFT: 2 });
    expect(await voucherByCode('EDIT')).toMatchObject({ pointsCost: 250, importBatchId: next.batch.id });

    const detail = (await ctx.http().get(`${api}/${next.batch.id}`).set(key).expect(200)).body;
    expect(detail.vouchers.map((v: { code: string }) => v.code)).toEqual(['EDIT', 'KEEP']);
  });

  it('activates each voucher with its own checks, and calling it again is safe', async () => {
    const { batch } = (await send({ items: [item('OK'), item('SOON', { expiresAt: later(2) })] }).expect(201)).body;
    const first = (await activate(batch.id).expect(201)).body;
    expect(first.vouchers).toEqual([
      { voucherId: expect.any(String), code: 'OK', outcome: 'publishing', reason: null },
      {
        voucherId: expect.any(String),
        code: 'SOON',
        outcome: 'failed',
        reason: expect.stringMatching(/at least 24 hours/),
      },
    ]);
    expect(await voucherByCode('OK')).toMatchObject({ status: 'DRAFT', publishStatus: 'PUBLISHING' });
    expect((await voucherByCode('SOON')).publishStatus).toBe('NOT_PUBLISHED');

    const second = (await activate(batch.id).expect(201)).body;
    expect(second.vouchers.map((v: { outcome: string }) => v.outcome)).toEqual(['skipped', 'failed']);
    // One publish command for OK, not two.
    const commands = await ctx.db.select().from(schema.operations);
    expect(commands.filter((c) => c.commandType === 'VOUCHER_TERMS_PUBLISH')).toHaveLength(1);
  });

  it('refuses activating without a program on-chain (422), and hides other organizations', async () => {
    const mine = (await send({ items: [item('MINE')] }).expect(201)).body.batch;
    const theirs = (await send({ items: [item('THEIRS')] }, otherKey).expect(201)).body.batch;
    expect((await activate(theirs.id, otherKey).expect(422)).body.message).toEqual(expect.any(String));
    await ctx.http().get(`${api}/${mine.id}`).set(otherKey).expect(404);
    await archive(mine.id, otherKey).expect(404);
    await ctx.http().get(`${api}/${theirs.id}`).set(key).expect(404);
    await archive(theirs.id).expect(404);
  });

  it('follows the approval rules: a Developer or an API key sends the batch to an Owner', async () => {
    await requireApproval();
    const byKey = (await send({ items: [item('K1')] }).expect(201)).body.batch;
    expect((await activate(byKey.id).expect(201)).body.vouchers[0].outcome).toBe('pendingApproval');
    expect((await voucherByCode('K1')).status).toBe('PENDING_APPROVAL');

    const byDeveloper = (
      await ctx
        .http()
        .post(consolePath())
        .set(as('developer'))
        .send({ items: [item('D1')] })
        .expect(201)
    ).body;
    expect(byDeveloper.batch).toMatchObject({ source: 'CONSOLE', createdBy: { type: 'USER', id: ids.developer } });
    const developerRun = (
      await ctx.http().post(`${consolePath()}/${byDeveloper.batch.id}/activate`).set(as('developer')).expect(201)
    ).body;
    expect(developerRun.vouchers[0].outcome).toBe('pendingApproval');
    const [request] = await ctx.db
      .select()
      .from(schema.voucherApprovalRequests)
      .where(eq(schema.voucherApprovalRequests.voucherId, (await voucherByCode('D1')).id));
    expect(request).toMatchObject({ status: 'PENDING', submittedByUserId: ids.developer });

    const byOwner = (
      await ctx
        .http()
        .post(consolePath())
        .set(as('owner'))
        .send({ items: [item('O1')] })
        .expect(201)
    ).body;
    const ownerRun = (
      await ctx.http().post(`${consolePath()}/${byOwner.batch.id}/activate`).set(as('owner')).expect(201)
    ).body;
    expect(ownerRun.vouchers[0].outcome).toBe('publishing');
  });

  it('lets the Owner and a Business Developer use the console routes, and nobody else', async () => {
    const created = (
      await ctx
        .http()
        .post(consolePath())
        .set(as('owner'))
        .send({ items: [item('X')] })
        .expect(201)
    ).body;
    expect(created.batch.createdBy).toEqual({ type: 'USER', id: ids.owner });
    const list = await ctx.http().get(consolePath()).set(as('developer')).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toHaveLength(1);
    await ctx.http().get(`${consolePath()}/${created.batch.id}`).set(as('developer')).expect(200);
    for (const actor of ['stranger', 'outsider'] as const) {
      await ctx.http().get(consolePath()).set(as(actor)).expect(403);
      await ctx
        .http()
        .post(consolePath())
        .set(as(actor))
        .send({ items: [item('Y')] })
        .expect(403);
      await ctx.http().post(`${consolePath()}/${created.batch.id}/archive`).set(as(actor)).expect(403);
    }
    await ctx.http().post(`${consolePath()}/${created.batch.id}/archive`).set(as('developer')).expect(201);
  });

  it('never answers 500 when two batches write the same code at once', async () => {
    const items = [item('RACE'), item('RACE2')];
    const results = await Promise.all([send({ items }), send({ items }), send({ items })]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const statuses = results.flatMap((r) => r.body.items.map((i: { status: string }) => i.status)).sort();
    expect(statuses.filter((s) => s === 'created')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'unchanged')).toHaveLength(4);
    expect(await ctx.db.select().from(schema.vouchers)).toHaveLength(2);
  });
});
