import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import {
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
  setOwnership,
} from './support/db.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';

const ACTORS = ['owner', 'developer', 'stranger', 'inactive', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

const reward = { code: 'coffee', title: 'Free coffee', discountType: 'FREE_ITEM', pointsCost: 100, totalSupply: 10 };

/** A well-formed approval request id that is no voucher's submission. */
const NO_SUBMISSION = '00000000-0000-4000-8000-000000000000';

describe('console rewards: list, create, edit, pause and activate from a Google session', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
  let memberId: string;
  let apiKey: { authorization: string };
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
  const path = (org = orgId) => `/v1/console/organizations/${org}/vouchers`;
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const create = (actor: Actor, body: Record<string, unknown> = reward, org = orgId) =>
    ctx.http().post(path(org)).set(as(actor)).send(body);
  const patch = (actor: Actor, id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`${path()}/${id}`).set(as(actor)).send(body);
  /** What the worker does once the chain holds the terms. */
  const publish = (id: string) => ctx.app.get(RewardsRepository).markVoucherPublished(id, `0xterms-${id}`);
  const settings = (actor: Actor, body: Record<string, unknown>) =>
    ctx.http().patch(`/v1/console/organizations/${orgId}/settings`).set(as(actor)).send(body);
  const action = (actor: Actor, id: string, name: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`${path()}/${id}/${name}`).set(as(actor)).send(body);
  const requireApproval = () => settings('owner', { voucherApprovalRequired: true }).expect(200);
  /** The submission an Owner reviews: the voucher's `approval.id` as the console shows it now (OCT-324). */
  const submission = async (id: string): Promise<string> =>
    (await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body.approval?.id ?? NO_SUBMISSION;
  const activate = async (id: string) => {
    await patch('owner', id, { status: 'ACTIVE' }).expect(200);
    await publish(id);
  };

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
      { organizationId: orgId, systemUserId: ids.inactive, role: 'OWNER', status: 'INACTIVE' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    memberId = (await seedMember(ctx.db, orgId)).memberId;
    await setOwnership(ctx.db, memberId, { confirmedBalance: 100, suiCreditAccountId: '0xaccount' });
    apiKey = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
  });

  it('lets the Owner create a DRAFT, activate, pause and activate it again', async () => {
    const created = await create('owner').expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    // A DRAFT stays off the chain, so every field can still change.
    expect(created.body).toMatchObject({
      code: 'coffee',
      pointsCost: 100,
      totalSupply: 10,
      claimedCount: 0,
      status: 'DRAFT',
      publishStatus: 'NOT_PUBLISHED',
    });
    const id = created.body.id as string;
    expect((await patch('owner', id, { title: 'Free latte' }).expect(200)).body.title).toBe('Free latte');

    // Activating queues the terms for the chain; ACTIVE once the worker has published them.
    expect((await patch('owner', id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
      status: 'DRAFT',
      publishStatus: 'PUBLISHING',
    });
    await publish(id);
    const detail = await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.body).toMatchObject({ status: 'ACTIVE', publishStatus: 'PUBLISHED', suiTermsId: `0xterms-${id}` });

    expect((await patch('owner', id, { status: 'PAUSED' }).expect(200)).body.status).toBe('PAUSED');
    // Already on-chain: activating again takes effect at once.
    expect((await patch('owner', id, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');
    // Supply can still change; the published promise cannot.
    expect((await patch('owner', id, { totalSupply: 20 }).expect(200)).body.totalSupply).toBe(20);
    expect((await patch('owner', id, { pointsCost: 50 }).expect(409)).body.message).toMatch(/cannot change after/);
  });

  it('requires pointsCost, allows 0, and reports validation errors and duplicates', async () => {
    const withoutCost: Record<string, unknown> = { ...reward };
    delete withoutCost.pointsCost;
    expect((await create('owner', withoutCost).expect(400)).body.message).toMatch(/pointsCost is required/);
    expect((await create('owner', { ...reward, code: 'free', pointsCost: 0 }).expect(201)).body.pointsCost).toBe(0);

    for (const [body, message] of [
      [{ ...reward, code: '' }, /code, title, and either discountType or terms are required/],
      [{ ...reward, pointsCost: -1 }, /pointsCost must be a nonnegative/],
      [{ ...reward, startsAt: '2026-11-20' }, /ISO date-time with a timezone/],
      [{ ...reward, claimedCount: 3 }, /unsupported fields/],
      [{ ...reward, status: 'ACTIVE' }, /created as DRAFT; activate it with PATCH/],
      [{ ...reward, status: 'PAUSED' }, /created as DRAFT/],
    ] as const) {
      expect((await create('owner', body).expect(400)).body.message).toMatch(message);
    }
    await create('owner').expect(201);
    expect((await create('owner').expect(409)).body.message).toMatch(/already exists/);
  });

  it('lets a Business Developer read the catalog and write drafts, and nobody else in', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    expect((await ctx.http().get(path()).set(as('developer')).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${path()}/${id}`).set(as('developer')).expect(200);
    await patch('developer', id, { title: 'Free coffee' }).expect(200);

    for (const actor of ['stranger', 'inactive', 'outsider'] as const) {
      await ctx.http().get(path()).set(as(actor)).expect(403);
      await ctx.http().get(`${path()}/${id}`).set(as(actor)).expect(403);
      await create(actor, { ...reward, code: actor }).expect(403);
      await patch(actor, id, { title: 'stolen' }).expect(403);
    }
    await ctx.http().post(path()).send(reward).expect(401);
    await ctx.http().get(path()).expect(401);

    const rows = await ctx.db.select().from(schema.vouchers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, status: 'DRAFT', title: 'Free coffee' });
  });

  it('changes nothing for an organization that is not ACTIVE', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await create('owner', { ...reward, code: 'late' }).expect(403);
    await patch('owner', id, { status: 'ACTIVE' }).expect(403);
    await ctx.http().get(path()).set(as('owner')).expect(403);
    expect((await ctx.db.select().from(schema.vouchers)).map((v) => v.status)).toEqual(['DRAFT']);
  });

  it('answers 404 for another organization’s voucher, and 400 for a malformed id', async () => {
    const foreign = (await create('outsider', reward, otherOrgId).expect(201)).body as { id: string };
    await ctx.http().get(`${path()}/${foreign.id}`).set(as('owner')).expect(404);
    await patch('owner', foreign.id, { title: 'mine now' }).expect(404);
    expect((await ctx.http().get(path()).set(as('owner')).expect(200)).body).toEqual([]);
    await ctx.http().get(`${path()}/not-a-uuid`).set(as('owner')).expect(400);
    await ctx
      .http()
      .get(`${path('not-a-uuid')}`)
      .set(as('owner'))
      .expect(400);
  });

  it('puts an activated reward in this organization’s API-key catalog only', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);
    const catalog = (await ctx.http().get('/v1/rewards/vouchers').set(apiKey).expect(200)).body as { id: string }[];
    expect(catalog).toEqual([expect.objectContaining({ id, status: 'ACTIVE' })]);

    const otherKey = { authorization: `Bearer ${(await seedCredential(ctx.db, otherOrgId)).rawKey}` };
    expect((await ctx.http().get('/v1/rewards/vouchers').set(otherKey).expect(200)).body).toEqual([]);
    await ctx.http().get(`/v1/rewards/vouchers/${id}`).set(otherKey).expect(404);
  });

  it('delivery scenario: an Owner’s 100-point reward, claimed for 100 points, used exactly once', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);

    const claimed = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${id}/claim`)
      .set(apiKey)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'console-reward-claim' })
      .expect(201);
    expect(claimed.body).toMatchObject({ pointsCost: 100, status: 'RESERVED' });
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claimed.body.digest, signature: 'customer-signature' })
      .expect(201);
    const balance = await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(apiKey).expect(200);
    expect(balance.body).toMatchObject({ confirmedBalance: 0, pendingRedemption: 0 });
    expect((await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body.claimedCount).toBe(1);

    const use = (key: string) =>
      ctx
        .http()
        .post('/v1/rewards/vouchers/use')
        .set(apiKey)
        .send({ serialCode: claimed.body.serialCode, idempotencyKey: key });
    const prepared = await use('use-1').expect(201);
    const redeemed = await ctx
      .http()
      .post('/v1/rewards/vouchers/use/finalize')
      .send({ digest: prepared.body.digest, signature: 'customer-signature' })
      .expect(201);
    expect(redeemed.body).toMatchObject({ status: 'REDEEMED', voucherTitle: 'Free coffee' });
    await use('use-2').expect(400);
  });

  it('does not deadlock with a claim: the Owner check holds the organization FOR SHARE', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);

    // Takes a claim's locks in a claim's order, with the console PATCH arriving in between:
    // the voucher FOR UPDATE, then (once the PATCH waits on that voucher) the organization FOR SHARE.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let markLocked!: () => void;
    const voucherLocked = new Promise<void>((resolve) => (markLocked = resolve));
    const claimLike = ctx.db.transaction(async (tx) => {
      await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)).for('update');
      markLocked();
      await gate;
      await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('share');
    });
    await voucherLocked;

    const edit = patch('owner', id, { totalSupply: 5 }).then((response) => response);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i += 1) {
      const [row] = await ctx.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      waiting = row.waiting;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The PATCH holds the organization and waits on the voucher.
    expect(waiting).toBe(1);

    // With the organization FOR UPDATE here, this would wait on the PATCH, which waits on it: a deadlock.
    openGate();
    await expect(claimLike).resolves.toBeUndefined();
    const response = await edit;
    expect(response.status).toBe(200);
    expect(response.body.totalSupply).toBe(5);
  });

  it('answers 409, not 500, to a create racing another one with the same code', async () => {
    // Another create holds the code, uncommitted, while the console create arrives: the console's
    // own lookup sees nothing, and its insert has to wait on the unique index.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let markInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (markInserted = resolve));
    const other = ctx.db.transaction(async (tx) => {
      await tx.insert(schema.vouchers).values({ organizationId: orgId, code: reward.code, title: 'First' });
      markInserted();
      await gate;
    });
    await inserted;

    const racing = create('owner').then((response) => response);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i += 1) {
      const [row] = await ctx.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      waiting = row.waiting;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(1);

    // Once the other create commits, ON CONFLICT DO NOTHING inserts nothing: a CONFLICT, so a 409.
    openGate();
    await other;
    const response = await racing;
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/already exists/);
    expect(await ctx.db.select().from(schema.vouchers)).toEqual([expect.objectContaining({ title: 'First' })]);
  });

  it('runs PATCH and a real claim on the same voucher at once without errors', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);
    const [edited, claimed] = await Promise.all([
      patch('owner', id, { totalSupply: 4 }),
      ctx
        .http()
        .post(`/v1/rewards/vouchers/${id}/claim`)
        .set(apiKey)
        .send({ organizationEndUserId: memberId, idempotencyKey: 'parallel-claim' }),
    ]);
    expect(edited.status).toBe(200);
    expect(claimed.status).toBe(201);
    expect((await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body).toMatchObject({
      totalSupply: 4,
      claimedCount: 1,
    });
  });
  describe('optional approval before a voucher goes live (OCT-59)', () => {
    it('with approval off, a Business Developer activates a draft, but only the Owner pauses or edits it once published', async () => {
      const { id } = (await create('developer').expect(201)).body as { id: string };
      expect((await patch('developer', id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
        status: 'DRAFT',
        publishStatus: 'PUBLISHING',
        approval: null,
      });
      await publish(id);
      expect((await patch('developer', id, { status: 'PAUSED' }).expect(403)).body.message).toMatch(
        /Only an Owner can/,
      );
      expect((await patch('developer', id, { totalSupply: 20 }).expect(403)).body.message).toMatch(/published/);
      await patch('owner', id, { status: 'PAUSED' }).expect(200);
      await action('developer', id, 'submit').expect(409);
    });

    it('only an Owner turns approval on or off, and the organization shows it', async () => {
      const org = () => ctx.http().get(`/v1/console/organizations/${orgId}`).set(as('developer')).expect(200);
      expect((await org()).body.voucherApprovalRequired).toBe(false);
      await settings('developer', { voucherApprovalRequired: true }).expect(403);
      await settings('owner', { voucherApprovalRequired: 'yes' }).expect(400);
      await settings('owner', { voucherApprovalRequired: true, name: 'x' }).expect(400);
      await settings('outsider', { voucherApprovalRequired: true }).expect(403);
      expect((await requireApproval()).body).toEqual({ updated: true });
      expect((await org()).body.voucherApprovalRequired).toBe(true);
    });

    it('with approval on, a draft goes through submit, withdraw, reject and approve before it is published', async () => {
      await requireApproval();
      const { id } = (await create('developer').expect(201)).body as { id: string };
      expect((await patch('developer', id, { status: 'ACTIVE' }).expect(403)).body.message).toMatch(
        /submit the voucher for approval/,
      );

      const submitted = await action('developer', id, 'submit').expect(201);
      expect(submitted.body).toMatchObject({
        status: 'PENDING_APPROVAL',
        publishStatus: 'NOT_PUBLISHED',
        approval: { status: 'PENDING', submittedBy: { type: 'USER', id: ids.developer }, reviewedById: null },
      });
      // Locked while waiting, for everyone, and nobody can submit it twice.
      await patch('developer', id, { title: 'Sneaky' }).expect(409);
      await patch('owner', id, { status: 'ACTIVE' }).expect(409);
      await action('developer', id, 'submit').expect(409);

      expect((await action('developer', id, 'withdraw').expect(201)).body).toMatchObject({
        status: 'DRAFT',
        approval: { status: 'WITHDRAWN', reviewedById: ids.developer },
      });
      await patch('developer', id, { title: 'Free latte' }).expect(200);
      await action('developer', id, 'submit').expect(201);

      // Only an Owner decides, and a rejection needs a reason.
      await action('developer', id, 'approve', { approvalRequestId: await submission(id) }).expect(403);
      await action('developer', id, 'reject', { approvalRequestId: await submission(id), reason: 'no' }).expect(403);
      await action('owner', id, 'reject', { approvalRequestId: await submission(id) }).expect(400);
      const rejected = await action('owner', id, 'reject', {
        approvalRequestId: await submission(id),
        reason: 'Cap too high',
      }).expect(201);
      expect(rejected.body).toMatchObject({
        status: 'DRAFT',
        approval: { status: 'REJECTED', reason: 'Cap too high', reviewedById: ids.owner },
      });
      await action('owner', id, 'approve', { approvalRequestId: await submission(id) }).expect(409);

      await action('developer', id, 'submit').expect(201);
      const approved = await action('owner', id, 'approve', { approvalRequestId: await submission(id) }).expect(201);
      expect(approved.body).toMatchObject({
        status: 'DRAFT',
        publishStatus: 'PUBLISHING',
        approval: { status: 'APPROVED', reviewedById: ids.owner },
      });
      await publish(id);
      const detail = (await ctx.http().get(`${path()}/${id}`).set(as('developer')).expect(200)).body;
      expect(detail).toMatchObject({ status: 'ACTIVE', title: 'Free latte', approval: { status: 'APPROVED' } });

      const history = await ctx.db
        .select()
        .from(schema.voucherApprovalRequests)
        .where(eq(schema.voucherApprovalRequests.voucherId, id));
      expect(history.map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED', 'WITHDRAWN']);
    });

    it('lets an Owner activate directly, and refuses an Owner submitting', async () => {
      await requireApproval();
      const { id } = (await create('owner').expect(201)).body as { id: string };
      expect((await action('owner', id, 'submit').expect(409)).body.message).toMatch(/Owner needs no approval/);
      expect((await patch('owner', id, { status: 'ACTIVE' }).expect(200)).body.publishStatus).toBe('PUBLISHING');
    });

    it('queues an API key asking for ACTIVE, and lets it resume a published voucher without approval', async () => {
      await requireApproval();
      const [credential] = await ctx.db
        .select()
        .from(schema.apiCredentials)
        .where(eq(schema.apiCredentials.organizationId, orgId));
      const created = await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(apiKey)
        .send({ ...reward, code: 'crm' })
        .expect(201);
      expect(created.body).toMatchObject({
        status: 'PENDING_APPROVAL',
        publishStatus: 'NOT_PUBLISHED',
        approval: { status: 'PENDING', submittedBy: { type: 'API_CREDENTIAL', id: credential.id } },
      });
      const id = created.body.id as string;
      // Not claimable while it waits.
      await ctx
        .http()
        .post(`/v1/rewards/vouchers/${id}/claim`)
        .set(apiKey)
        .send({ organizationEndUserId: memberId, idempotencyKey: 'too-early' })
        .expect(400);

      const draft = await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(apiKey)
        .send({ ...reward, code: 'crm-draft', status: 'DRAFT' })
        .expect(201);
      expect(draft.body.status).toBe('DRAFT');
      await ctx
        .http()
        .patch(`/v1/rewards/vouchers/${draft.body.id}`)
        .set(apiKey)
        .send({ status: 'ACTIVE' })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('PENDING_APPROVAL'));

      await action('owner', id, 'approve', { approvalRequestId: await submission(id) }).expect(201);
      await publish(id);
      const key = (body: Record<string, unknown>) =>
        ctx.http().patch(`/v1/rewards/vouchers/${id}`).set(apiKey).send(body).expect(200);
      expect((await key({ status: 'PAUSED' })).body.status).toBe('PAUSED');
      // Already published: the terms on-chain cannot change, so resuming needs nobody's approval.
      expect((await key({ status: 'ACTIVE' })).body.status).toBe('ACTIVE');
    });

    it('checks the use window again when approving, and leaves waiting vouchers alone when approval is turned off', async () => {
      await requireApproval();
      const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const late = (await create('developer', { ...reward, code: 'late', expiresAt: soon }).expect(201)).body.id;
      const kept = (await create('developer', { ...reward, code: 'kept' }).expect(201)).body.id;
      await action('developer', late, 'submit').expect(201);
      await action('developer', kept, 'submit').expect(201);

      // Days pass while it waits.
      await ctx.db
        .update(schema.vouchers)
        .set({ expiresAt: new Date(Date.now() + 3_600_000) })
        .where(eq(schema.vouchers.id, late));
      expect(
        (await action('owner', late, 'approve', { approvalRequestId: await submission(late) }).expect(400)).body
          .message,
      ).toMatch(/at least 24 hours/);
      await action('owner', late, 'reject', {
        approvalRequestId: await submission(late),
        reason: 'Expired while waiting',
      }).expect(201);

      await settings('owner', { voucherApprovalRequired: false }).expect(200);
      expect((await ctx.http().get(`${path()}/${kept}`).set(as('owner')).expect(200)).body.status).toBe(
        'PENDING_APPROVAL',
      );
      // With approval off nothing new is queued, but the one already waiting can still be decided.
      const fresh = (await create('developer', { ...reward, code: 'fresh' }).expect(201)).body.id;
      expect((await action('developer', fresh, 'submit').expect(409)).body.message).toMatch(
        /does not require approval/,
      );
      await action('owner', kept, 'approve', { approvalRequestId: await submission(kept) }).expect(201);
    });

    describe('approving only what the Owner reviewed, and who created and took it live (OCT-324)', () => {
      const publishCommands = async (voucherId: string) =>
        (await ctx.db.select().from(schema.operations)).filter(
          (c) =>
            c.commandType === 'VOUCHER_TERMS_PUBLISH' && (c.payload as { voucherId?: string }).voucherId === voucherId,
        );

      it('refuses a decision on a submission that was withdrawn and submitted again with new terms', async () => {
        await requireApproval();
        const { id } = (
          await create('developer', { ...reward, discountType: 'FIXED_AMOUNT', discountValue: '50000' }).expect(201)
        ).body as { id: string };
        await action('developer', id, 'submit').expect(201);
        // The Owner opens the review: this is the submission they see.
        const reviewed = await submission(id);
        expect((await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body.approval).toMatchObject({
          id: reviewed,
          snapshot: { code: 'coffee', discountType: 'FIXED_AMOUNT', discountValue: '50000.00', totalSupply: 10 },
        });

        // Meanwhile the Developer takes it back, raises the discount and submits it again.
        await action('developer', id, 'withdraw').expect(201);
        await patch('developer', id, { discountValue: '500000' }).expect(200);
        await action('developer', id, 'submit').expect(201);

        const approve = await action('owner', id, 'approve', { approvalRequestId: reviewed }).expect(409);
        expect(approve.body.message).toMatch(/submitted again since you reviewed it/);
        const reject = await action('owner', id, 'reject', { approvalRequestId: reviewed, reason: 'Too much' }).expect(
          409,
        );
        expect(reject.body.message).toMatch(/submitted again/);
        await action('owner', id, 'approve', { approvalRequestId: NO_SUBMISSION }).expect(409);
        // Nothing was decided or published.
        const detail = (await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body;
        expect(detail).toMatchObject({
          status: 'PENDING_APPROVAL',
          publishStatus: 'NOT_PUBLISHED',
          activatedBy: null,
          approval: { status: 'PENDING', snapshot: { discountValue: '500000.00' } },
        });
        expect(detail.approval.id).not.toBe(reviewed);
        expect(await publishCommands(id)).toHaveLength(0);

        // Reviewing the new submission, the Owner approves what they now see.
        const approved = await action('owner', id, 'approve', { approvalRequestId: detail.approval.id }).expect(201);
        expect(approved.body).toMatchObject({
          publishStatus: 'PUBLISHING',
          discountValue: '500000.00',
          createdBy: { type: 'USER', id: ids.developer },
          activatedBy: { type: 'USER', id: ids.owner },
          activatedAt: expect.any(String),
          approval: { id: detail.approval.id, status: 'APPROVED' },
        });
        expect(await publishCommands(id)).toHaveLength(1);
      });

      it('refuses to approve terms that changed after they were submitted', async () => {
        await requireApproval();
        const { id } = (await create('developer').expect(201)).body as { id: string };
        await action('developer', id, 'submit').expect(201);
        const reviewed = await submission(id);
        // No route edits a waiting voucher; this stands for any path that would.
        await ctx.db.update(schema.vouchers).set({ pointsCost: 1 }).where(eq(schema.vouchers.id, id));
        const refused = await action('owner', id, 'approve', { approvalRequestId: reviewed }).expect(409);
        expect(refused.body.message).toMatch(/changed after it was submitted/);
        expect(await publishCommands(id)).toHaveLength(0);
        // Rejecting it is still possible.
        await action('owner', id, 'reject', { approvalRequestId: reviewed, reason: 'Changed' }).expect(201);
      });

      it('requires the reviewed submission to approve or reject (400)', async () => {
        await requireApproval();
        const { id } = (await create('developer').expect(201)).body as { id: string };
        await action('developer', id, 'submit').expect(201);
        for (const body of [{}, { approvalRequestId: 'nope' }]) {
          expect((await action('owner', id, 'approve', body).expect(400)).body.message).toMatch(
            /approvalRequestId is required/,
          );
          await action('owner', id, 'reject', { ...body, reason: 'no' }).expect(400);
        }
      });

      it('records who created a voucher and who took it live, with or without approval', async () => {
        const [credential] = await ctx.db
          .select()
          .from(schema.apiCredentials)
          .where(eq(schema.apiCredentials.organizationId, orgId));
        const key = { type: 'API_CREDENTIAL', id: credential.id };

        // The Owner creates and activates.
        const own = (await create('owner', { ...reward, code: 'own' }).expect(201)).body;
        expect(own).toMatchObject({ createdBy: { type: 'USER', id: ids.owner }, activatedBy: null, activatedAt: null });
        expect((await patch('owner', own.id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
          activatedBy: { type: 'USER', id: ids.owner },
          activatedAt: expect.any(String),
        });

        // With approval off, a Business Developer activates their own draft.
        const bd = (await create('developer', { ...reward, code: 'bd' }).expect(201)).body;
        expect((await patch('developer', bd.id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
          createdBy: { type: 'USER', id: ids.developer },
          activatedBy: { type: 'USER', id: ids.developer },
        });

        // An API key creating it live is both.
        const crm = await ctx
          .http()
          .post('/v1/rewards/vouchers')
          .set(apiKey)
          .send({ ...reward, code: 'crm' })
          .expect(201);
        expect(crm.body).toMatchObject({ createdBy: key, activatedBy: key });

        // A Business Developer's draft activated by the Owner: created by one, taken live by the other.
        const handed = (await create('developer', { ...reward, code: 'handed' }).expect(201)).body;
        expect((await patch('owner', handed.id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
          createdBy: { type: 'USER', id: ids.developer },
          activatedBy: { type: 'USER', id: ids.owner },
        });
      });
    });

    it('does not deadlock with a claim when a Business Developer edits: the check holds the organization FOR SHARE', async () => {
      const { id } = (await create('owner').expect(201)).body as { id: string };
      await activate(id);
      await patch('owner', id, { status: 'PAUSED' }).expect(200);
      const draft = (await create('developer', { ...reward, code: 'bd-draft' }).expect(201)).body.id as string;

      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let markLocked!: () => void;
      const voucherLocked = new Promise<void>((resolve) => (markLocked = resolve));
      const claimLike = ctx.db.transaction(async (tx) => {
        await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, draft)).for('update');
        markLocked();
        await gate;
        await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('share');
      });
      await voucherLocked;

      const edit = patch('developer', draft, { totalSupply: 5 }).then((response) => response);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i += 1) {
        const [row] = await ctx.db.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
        );
        waiting = row.waiting;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(1);

      openGate();
      await expect(claimLike).resolves.toBeUndefined();
      const response = await edit;
      expect(response.status).toBe(200);
      expect(response.body.totalSupply).toBe(5);
    });
  });
});
