import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedCredential, seedMember, seedOrganization, seedProgram } from './support/db.js';
import { CampaignsRepository } from '#infra/db/repositories/campaigns.repository.js';
import { CampaignCloseWorker } from '#domain/rewards/campaign-close.worker.js';

const ACTORS = ['owner', 'developer', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const voucher = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  title: `Reward ${code}`,
  discountType: 'PERCENTAGE',
  discountValue: '20',
  pointsCost: 100,
  ...extra,
});

/** OCT-340: campaigns boost the earns that name them, and group vouchers. */
describe('campaigns', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
  let key: { Authorization: string };
  let memberId: string;
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
  const path = (org = orgId) => `/v1/console/organizations/${org}/campaigns`;
  const create = (body: Record<string, unknown>, actor: Actor = 'owner', org = orgId) =>
    ctx.http().post(path(org)).set(as(actor)).send(body);
  const act = (id: string, action: string, actor: Actor = 'owner') =>
    ctx.http().post(`${path()}/${id}/${action}`).set(as(actor)).send({});
  const live = async (extra: Record<string, unknown> = {}) => {
    const campaign = (
      await create({ name: 'Weekend 2x', startsAt: at(-1), endsAt: at(48), multiplierBps: 20_000, ...extra }).expect(
        201,
      )
    ).body;
    await act(campaign.id, 'activate').expect(201);
    return campaign.id as string;
  };
  const earn = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/v1/credits/earn')
      .set(key)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100_000, ...body });

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
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    key = { Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
    memberId = (await seedMember(ctx.db, orgId)).memberId;
  });

  describe('lifecycle', () => {
    it('validates a new campaign', async () => {
      const base = { name: 'Tết', startsAt: at(1), endsAt: at(24) };
      for (const [body, message] of [
        [{ ...base, name: ' ' }, /name must be/],
        [{ ...base, endsAt: at(0) }, /endsAt must be after startsAt/],
        [{ ...base, startsAt: 'soon' }, /startsAt must be an ISO 8601/],
        [{ ...base, multiplierBps: 10_000 }, /above 10000/],
        [{ ...base, multiplierBps: 100_001 }, /at most 100000/],
        [{ ...base, multiplierBps: 1.5 }, /whole number/],
        [{ ...base, budget: 5 }, /unsupported fields/],
      ] as const) {
        expect((await create(body).expect(400)).body.message).toMatch(message);
      }
      // Vouchers-only (no multiplier) is fine.
      expect((await create(base).expect(201)).body).toMatchObject({ multiplierBps: null, status: 'DRAFT' });
    });

    it('lets a Business Developer draft and only the Owner approve and move it', async () => {
      const draft = (
        await create(
          { name: 'Weekend 2x', startsAt: at(-1), endsAt: at(48), multiplierBps: 20_000 },
          'developer',
        ).expect(201)
      ).body;
      expect(draft).toMatchObject({ status: 'DRAFT', createdByUserId: ids.developer, earnBoostLive: false });
      await act(draft.id, 'activate', 'developer').expect(403);
      await create({ name: 'x', startsAt: at(1), endsAt: at(2) }, 'outsider').expect(403);

      const active = (await act(draft.id, 'activate').expect(201)).body;
      expect(active).toMatchObject({ status: 'ACTIVE', approvedByUserId: ids.owner, earnBoostLive: true });
      await act(draft.id, 'activate').expect(409);
      expect((await act(draft.id, 'pause').expect(201)).body.status).toBe('PAUSED');
      expect((await act(draft.id, 'resume').expect(201)).body).toMatchObject({
        status: 'ACTIVE',
        approvedAt: active.approvedAt,
      });
      expect((await act(draft.id, 'end').expect(201)).body.status).toBe('ENDED');
      await act(draft.id, 'resume').expect(409);
      expect((await act(draft.id, 'archive').expect(201)).body.status).toBe('ARCHIVED');

      const listed = (await ctx.http().get(path()).set(as('developer')).expect(200)).body;
      expect(listed).toEqual([]);
      const all = (await ctx.http().get(`${path()}?includeArchived=true`).set(as('developer')).expect(200)).body;
      expect(all.map((c: { id: string }) => c.id)).toEqual([draft.id]);
      // Another organization's campaign is not found.
      await ctx
        .http()
        .get(`${path(otherOrgId)}/${draft.id}`)
        .set(as('outsider'))
        .expect(404);

      const audit = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, draft.id));
      expect(audit.map((row) => row.action).sort()).toEqual(
        [
          'campaign.activated',
          'campaign.archived',
          'campaign.created',
          'campaign.ended',
          'campaign.paused',
          'campaign.resumed',
        ].sort(),
      );
      // The terms are in the audit log, so the sealed evidence (OCT-77) shows what was approved.
      expect(audit.find((row) => row.action === 'campaign.created')?.changes).toEqual({
        name: 'Weekend 2x',
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        multiplierBps: 20_000,
      });
    });

    it('refuses to activate a campaign whose window is already over', async () => {
      const over = (await create({ name: 'Last week', startsAt: at(-48), endsAt: at(-1) }).expect(201)).body;
      expect((await act(over.id, 'activate').expect(409)).body.message).toMatch(/already ended/);
    });
  });

  describe('earn', () => {
    it('boosts an earn that names a live campaign, and records it for the chain and for reporting', async () => {
      const campaignId = await live();
      const res = (await earn({ idempotencyKey: 'boosted', campaignId }).expect(201)).body;
      // 100000 at the seeded 100 bps is 1000 points; at 2x, 2000.
      expect(res).toMatchObject({ status: 'PENDING', estimatedPoints: 2000 });
      const [tx] = await ctx.db
        .select()
        .from(schema.loyaltyTransactions)
        .where(eq(schema.loyaltyTransactions.id, res.transactionId));
      expect(tx).toMatchObject({ campaignId, pointsAmount: 2000 });
      const [command] = await ctx.db
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.idempotencyKey, 'boosted'));
      expect(command.payload).toMatchObject({ multiplierBps: 20_000, purchaseAmount: 100_000, campaignId });

      // An ordinary earn is unchanged.
      const plain = (await earn({ idempotencyKey: 'plain' }).expect(201)).body;
      expect(plain.estimatedPoints).toBe(1000);
      const [plainCommand] = await ctx.db
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.idempotencyKey, 'plain'));
      expect(plainCommand.payload).toMatchObject({ multiplierBps: 10_000 });
      expect(plainCommand.payload).not.toHaveProperty('campaignId');
    });

    it('refuses an earn naming a campaign that cannot boost it, never earning at the base rate', async () => {
      const otherCampaign = (
        await create(
          { name: 'Theirs', startsAt: at(-1), endsAt: at(48), multiplierBps: 20_000 },
          'outsider',
          otherOrgId,
        ).expect(201)
      ).body.id;
      const draft = (
        await create({ name: 'Not yet', startsAt: at(-1), endsAt: at(48), multiplierBps: 20_000 }).expect(201)
      ).body.id;
      const future = await live({ name: 'Next week', startsAt: at(100), endsAt: at(200) });
      const vouchersOnly = await live({ name: 'Vouchers', multiplierBps: null });
      const paused = await live({ name: 'Paused' });
      await act(paused, 'pause').expect(201);

      for (const [campaignId, message] of [
        [otherCampaign, /not found for this organization/],
        [draft, /is DRAFT/],
        [future, /starts at/],
        [vouchersOnly, /boosts no earn/],
        [paused, /is PAUSED/],
      ] as const) {
        expect((await earn({ idempotencyKey: `k-${campaignId}`, campaignId }).expect(422)).body.message).toMatch(
          message,
        );
      }
      await earn({ idempotencyKey: 'bad-id', campaignId: 'weekend' }).expect(400);
      expect(await ctx.db.select().from(schema.loyaltyTransactions)).toEqual([]);
    });

    it('answers a replay with the original earn, and rejects the same key with another campaign', async () => {
      const campaignId = await live();
      const first = (await earn({ idempotencyKey: 'replayed', campaignId }).expect(201)).body;
      const again = (await earn({ idempotencyKey: 'replayed', campaignId }).expect(201)).body;
      expect(again.transactionId).toBe(first.transactionId);
      await earn({ idempotencyKey: 'replayed' }).expect(409);

      // An accepted earn is reported even once its campaign has closed: the retry skips the gates.
      await act(campaignId, 'end').expect(201);
      expect((await earn({ idempotencyKey: 'replayed', campaignId }).expect(201)).body.transactionId).toBe(
        first.transactionId,
      );
    });

    it('answers a sandbox replay with the original earn once its campaign has closed, as live does', async () => {
      const sandbox = {
        Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { environment: 'SANDBOX' })).rawKey}`,
      };
      const sandboxEarn = (body: Record<string, unknown>) =>
        ctx
          .http()
          .post('/v1/credits/earn')
          .set(sandbox)
          .send({ organizationEndUserId: memberId, purchaseAmount: 100_000, idempotencyKey: 'sbx', ...body });
      const campaignId = await live();
      const first = (await sandboxEarn({ campaignId }).expect(201)).body;
      expect(first).toMatchObject({ isSandbox: true, pointsEarned: 2000 });

      await act(campaignId, 'end').expect(201);
      const again = (await sandboxEarn({ campaignId }).expect(201)).body;
      expect(again).toMatchObject({ transactionId: first.transactionId, pointsEarned: 2000 });
      // New work is still refused, and the same key without the campaign is still a conflict.
      await sandboxEarn({ idempotencyKey: 'sbx-new', campaignId }).expect(422);
      await sandboxEarn({}).expect(409);
    });
  });

  describe('closing when the window ends (OCT-343)', () => {
    const sweep = () => new CampaignCloseWorker(ctx.app.get(CampaignsRepository, { strict: false })).sweepOnce();
    const statusOf = async (id: string) =>
      (await ctx.db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0].status;
    /** Moves a campaign's window into the past, as time passing would. */
    const over = (id: string) =>
      ctx.db
        .update(schema.campaigns)
        .set({ startsAt: new Date(Date.now() - 3 * 3600_000), endsAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.campaigns.id, id));
    const endedRows = async (id: string) =>
      (await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, id))).filter(
        (row) => row.action === 'campaign.ended',
      );

    it('ends ACTIVE and PAUSED campaigns whose window is over, once, from the system', async () => {
      const active = await live();
      const paused = await live({ name: 'Paused' });
      await act(paused, 'pause').expect(201);
      const running = await live({ name: 'Still on' });
      const draft = (await create({ name: 'Draft', startsAt: at(-1), endsAt: at(48) }).expect(201)).body.id;
      for (const id of [active, paused, draft]) await over(id);

      expect(await sweep()).toBe(2);
      expect(await statusOf(active)).toBe('ENDED');
      expect(await statusOf(paused)).toBe('ENDED');
      expect(await statusOf(running)).toBe('ACTIVE');
      // A DRAFT past its window can't be activated anyway; it stays a DRAFT, to be archived.
      expect(await statusOf(draft)).toBe('DRAFT');

      const [row] = await endedRows(active);
      expect(row).toMatchObject({
        actorType: 'SYSTEM',
        actorId: null,
        changes: { status: { from: 'ACTIVE', to: 'ENDED' }, reason: 'window_ended' },
      });
      expect((await endedRows(paused))[0].changes).toMatchObject({ status: { from: 'PAUSED', to: 'ENDED' } });

      // A second sweep finds nothing, and writes nothing twice.
      expect(await sweep()).toBe(0);
      expect(await endedRows(active)).toHaveLength(1);
    });

    it('shows a campaign that is over as ENDED on every read, before any sweep', async () => {
      const inConsole = await live({ name: 'Console' });
      const apiKey = await live({ name: 'API key' });
      await over(inConsole);
      await over(apiKey);

      const list = (await ctx.http().get(path()).set(as('developer')).expect(200)).body;
      expect(list.find((c: { id: string }) => c.id === inConsole)).toMatchObject({
        status: 'ENDED',
        earnBoostLive: false,
      });
      expect((await ctx.http().get(`/v1/campaigns/${apiKey}`).set(key).expect(200)).body.status).toBe('ENDED');
      // The read wrote the system's audit row, not the reader's.
      expect((await endedRows(inConsole))[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
      expect(await sweep()).toBe(0);
    });

    it('keeps an ENDED campaign final but archivable, and refuses to pause one that is over', async () => {
      const due = await live();
      await over(due);
      // Not read or swept yet: still ACTIVE in the row, but its window is over.
      await act(due, 'pause').expect(409);
      await sweep();
      await act(due, 'resume').expect(409);
      await act(due, 'activate').expect(409);
      await act(due, 'archive').expect(201);
      expect(await statusOf(due)).toBe('ARCHIVED');
    });

    it('takes no new vouchers once over, and shows ENDED after a bulk action, before any sweep', async () => {
      const due = await live();
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send({ ...voucher('IN-TIME'), status: 'DRAFT', campaignId: due })
        .expect(201);
      await over(due);
      expect(
        (
          await ctx
            .http()
            .post('/v1/rewards/vouchers')
            .set(key)
            .send({ ...voucher('TOO-LATE'), status: 'DRAFT', campaignId: due })
            .expect(409)
        ).body.message,
      ).toMatch(/ended at/);
      await ctx
        .http()
        .post('/v1/rewards/voucher-batches')
        .set(key)
        .send({ campaignId: due, items: [voucher('LATE-BATCH')] })
        .expect(409);

      const archived = (await act(due, 'vouchers/archive').expect(201)).body;
      expect(archived.campaign).toMatchObject({ id: due, status: 'ENDED' });
      expect(archived.vouchers.map((v: { code: string }) => v.code)).toEqual(['IN-TIME']);
    });
  });

  describe('API key reads', () => {
    it('lists the live campaigns for a till, reads one, and never another organization’s', async () => {
      const weekend = await live();
      const paused = await live({ name: 'Paused' });
      await act(paused, 'pause').expect(201);
      const vouchersOnly = await live({ name: 'Vouchers', multiplierBps: null });
      const draft = (
        await create({ name: 'Draft', startsAt: at(-1), endsAt: at(48), multiplierBps: 20_000 }).expect(201)
      ).body.id;
      const archived = await live({ name: 'Gone' });
      await act(archived, 'archive').expect(201);
      const theirs = (
        await create({ name: 'Theirs', startsAt: at(-1), endsAt: at(48) }, 'outsider', otherOrgId).expect(201)
      ).body.id;

      const all = (await ctx.http().get('/v1/campaigns').set(key).expect(200)).body;
      expect(all.map((c: { id: string }) => c.id).sort()).toEqual([weekend, paused, vouchersOnly, draft].sort());
      const liveOnes = (await ctx.http().get('/v1/campaigns?live=true').set(key).expect(200)).body;
      expect(liveOnes).toEqual([expect.objectContaining({ id: weekend, multiplierBps: 20_000, earnBoostLive: true })]);
      await ctx.http().get('/v1/campaigns?live=yes').set(key).expect(400);

      expect((await ctx.http().get(`/v1/campaigns/${weekend}`).set(key).expect(200)).body.name).toBe('Weekend 2x');
      await ctx.http().get(`/v1/campaigns/${theirs}`).set(key).expect(404);

      // A sandbox key reads the same campaigns, to test the till's picker.
      const sandbox = {
        Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { environment: 'SANDBOX' })).rawKey}`,
      };
      expect((await ctx.http().get('/v1/campaigns?live=true').set(sandbox).expect(200)).body).toHaveLength(1);
    });
  });

  describe('vouchers', () => {
    it('stamps a batch, and a single voucher, with the campaign, keeping the batch as it is', async () => {
      const campaignId = (await create({ name: 'Tết', startsAt: at(1), endsAt: at(200) }).expect(201)).body.id;
      const batch = (
        await ctx
          .http()
          .post(`/v1/console/organizations/${orgId}/voucher-batches`)
          .set(as('developer'))
          .send({ campaignId, items: [voucher('TET-A'), voucher('TET-B')] })
          .expect(201)
      ).body;
      const single = (
        await ctx
          .http()
          .post('/v1/rewards/vouchers')
          .set(key)
          .send({ ...voucher('TET-C'), status: 'DRAFT', campaignId })
          .expect(201)
      ).body;
      expect(single.campaignId).toBe(campaignId);
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send(voucher('PLAIN', { status: 'DRAFT' }))
        .expect(201);

      const rows = await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.campaignId, campaignId));
      expect(rows.map((v) => v.code).sort()).toEqual(['TET-A', 'TET-B', 'TET-C']);
      expect(rows.filter((v) => v.importBatchId === batch.batch.id)).toHaveLength(2);

      const detail = (await ctx.http().get(`${path()}/${campaignId}`).set(as('developer')).expect(200)).body;
      expect(detail).toMatchObject({ id: campaignId, multiplierBps: null });
      expect(detail.vouchers.map((v: { code: string }) => v.code)).toEqual(['TET-A', 'TET-B', 'TET-C']);
      expect(detail.vouchers.every((v: { campaignId: string }) => v.campaignId === campaignId)).toBe(true);
    });

    it('refuses a campaign on a batch item, another organization’s campaign, and a closed one', async () => {
      const campaignId = (await create({ name: 'Tết', startsAt: at(1), endsAt: at(200) }).expect(201)).body.id;
      const res = (
        await ctx
          .http()
          .post('/v1/rewards/voucher-batches')
          .set(key)
          .send({ items: [voucher('ITEM', { campaignId })] })
          .expect(201)
      ).body;
      expect(res.items[0]).toMatchObject({ status: 'error', error: { field: 'campaignId' } });

      const theirs = (
        await create({ name: 'Theirs', startsAt: at(1), endsAt: at(2) }, 'outsider', otherOrgId).expect(201)
      ).body.id;
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send({ ...voucher('X'), status: 'DRAFT', campaignId: theirs })
        .expect(404);

      await act(campaignId, 'archive').expect(201);
      await ctx
        .http()
        .post('/v1/rewards/voucher-batches')
        .set(key)
        .send({ campaignId, items: [voucher('LATE')] })
        .expect(409);
      // A voucher's campaign is set on create only.
      const plain = (
        await ctx
          .http()
          .post('/v1/rewards/vouchers')
          .set(key)
          .send(voucher('P', { status: 'DRAFT' }))
          .expect(201)
      ).body;
      await ctx.http().patch(`/v1/rewards/vouchers/${plain.id}`).set(key).send({ campaignId }).expect(400);
    });

    it('gives an archived code brought back by a batch that batch’s campaign, or none', async () => {
      const first = (await create({ name: 'Tết', startsAt: at(1), endsAt: at(200) }).expect(201)).body.id;
      const second = (await create({ name: 'Summer', startsAt: at(1), endsAt: at(200) }).expect(201)).body.id;
      const batch = (campaignId?: string) =>
        ctx
          .http()
          .post('/v1/rewards/voucher-batches')
          .set(key)
          .send({ ...(campaignId ? { campaignId } : {}), items: [voucher('TET10')] })
          .expect(201);
      const campaignOf = async () =>
        (await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.code, 'TET10')))[0].campaignId;

      await batch(first);
      await act(first, 'vouchers/archive').expect(201);
      await batch();
      expect(await campaignOf()).toBeNull();
      expect((await ctx.http().get(`${path()}/${first}`).set(as('owner')).expect(200)).body.vouchers).toEqual([]);

      // Archived again, then brought back into another campaign.
      await ctx.db.update(schema.vouchers).set({ status: 'ARCHIVED' }).where(eq(schema.vouchers.code, 'TET10'));
      await batch(second);
      expect(await campaignOf()).toBe(second);
    });

    it('archives, and lets only the Owner pause, every voucher of the campaign at once', async () => {
      const campaignId = (await create({ name: 'Tết', startsAt: at(1), endsAt: at(200) }).expect(201)).body.id;
      await ctx
        .http()
        .post(`/v1/console/organizations/${orgId}/voucher-batches`)
        .set(as('owner'))
        .send({ campaignId, items: [voucher('TET-A'), voucher('TET-B')] })
        .expect(201);
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send(voucher('OUTSIDE', { status: 'DRAFT' }))
        .expect(201);

      await act(campaignId, 'vouchers/pause', 'developer').expect(403);
      const paused = (await act(campaignId, 'vouchers/pause').expect(201)).body;
      // Drafts are not on-chain: nothing to pause.
      expect(paused.vouchers.map((v: { outcome: string }) => v.outcome)).toEqual(['skipped', 'skipped']);

      const archived = (await act(campaignId, 'vouchers/archive', 'developer').expect(201)).body;
      expect(archived.campaign).toMatchObject({ id: campaignId, status: 'DRAFT' });
      expect(archived.vouchers.map((v: { code: string; outcome: string }) => [v.code, v.outcome])).toEqual([
        ['TET-A', 'archived'],
        ['TET-B', 'archived'],
      ]);
      const outside = await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.code, 'OUTSIDE'));
      expect(outside[0].status).toBe('DRAFT');
    });
  });
});
