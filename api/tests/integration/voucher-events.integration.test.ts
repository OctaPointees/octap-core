import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import {
  deliveriesWithEvents,
  eventTypes,
  eventsOfType,
  resetDb,
  schema,
  seedCredential,
  seedOrganization,
  seedProgram,
} from './support/db.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';

const ACTORS = ['owner', 'developer'] as const;
type Actor = (typeof ACTORS)[number];

const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const voucher = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  title: `Reward ${code}`,
  discountType: 'PERCENTAGE',
  discountValue: '20',
  pointsCost: 100,
  expiresAt: later(72),
  ...extra,
});

/** Voucher lifecycle webhooks through the outbox (OCT-325): one event per change, in its transaction. */
describe('voucher lifecycle events (OCT-325)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let key: { Authorization: string };
  let credentialId: string;
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
  const consoleVouchers = () => `/v1/console/organizations/${orgId}/vouchers`;
  const rewards = () => ctx.app.get(RewardsRepository, { strict: false });
  const events = async (type: string) =>
    (await eventsOfType(ctx.db, type)).map((event) => event.payload as Record<string, unknown>);
  const createByKey = async (body: Record<string, unknown>) =>
    (await ctx.http().post('/v1/rewards/vouchers').set(key).send(body).expect(201)).body as { id: string };
  const patchByKey = (id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/v1/rewards/vouchers/${id}`).set(key).send(body);
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
    await seedProgram(ctx.db, orgId);
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
    ]);
    const seeded = await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] });
    key = { Authorization: `Bearer ${seeded.rawKey}` };
    credentialId = seeded.credential.id;
  });

  it('created, activated on chain confirmation only, paused, and activated again on resume', async () => {
    const { id } = await createByKey(voucher('LIVE', { status: 'DRAFT' }));
    expect(await events('voucher.created')).toMatchObject([
      {
        voucherId: id,
        code: 'LIVE',
        status: 'DRAFT',
        publishStatus: 'NOT_PUBLISHED',
        createdBy: { type: 'API_CREDENTIAL', id: credentialId },
        activatedBy: null,
      },
    ]);

    await patchByKey(id, { status: 'ACTIVE' }).expect(200);
    // Publishing is not live yet: nothing until the chain holds the terms.
    expect(await eventTypes(ctx.db)).toEqual(['voucher.created']);

    await rewards().markVoucherPublished(id, '0xterms');
    await rewards().markVoucherPublished(id, '0xterms');
    expect(await events('voucher.activated')).toMatchObject([
      {
        voucherId: id,
        status: 'ACTIVE',
        publishStatus: 'PUBLISHED',
        suiTermsId: '0xterms',
        activatedBy: { type: 'API_CREDENTIAL', id: credentialId },
        activatedAt: expect.any(String),
      },
    ]);

    await patchByKey(id, { status: 'PAUSED' }).expect(200);
    await patchByKey(id, { status: 'PAUSED' }).expect(200);
    await patchByKey(id, { status: 'ACTIVE' }).expect(200);
    expect(await eventTypes(ctx.db)).toEqual([
      'voucher.created',
      'voucher.activated',
      'voucher.paused',
      'voucher.activated',
    ]);
  });

  it('a voucher paused while publishing reports activated only once resumed; a failed publish reports it', async () => {
    const paused = await createByKey(voucher('PAUSED', { status: 'ACTIVE' }));
    expect(await events('voucher.created')).toMatchObject([{ status: 'DRAFT', publishStatus: 'PUBLISHING' }]);
    await patchByKey(paused.id, { status: 'PAUSED' }).expect(200);
    await rewards().markVoucherPublished(paused.id, '0xterms-paused');
    expect(await eventTypes(ctx.db)).toEqual(['voucher.created', 'voucher.paused']);
    await patchByKey(paused.id, { status: 'ACTIVE' }).expect(200);
    expect(await events('voucher.activated')).toMatchObject([{ voucherId: paused.id, status: 'ACTIVE' }]);

    const failing = await createByKey(voucher('FAILING', { status: 'ACTIVE' }));
    await rewards().failVoucherPublish(failing.id);
    await rewards().failVoucherPublish(failing.id);
    expect(await events('voucher.publish.failed')).toMatchObject([
      { voucherId: failing.id, status: 'DRAFT', publishStatus: 'FAILED' },
    ]);
  });

  it('feeds an approval queue: submitted, returned when rejected or withdrawn, activated once approved and live', async () => {
    await requireApproval();
    const created = (await ctx.http().post(consoleVouchers()).set(as('developer')).send(voucher('QUEUED')).expect(201))
      .body as { id: string };
    const submit = () => ctx.http().post(`${consoleVouchers()}/${created.id}/submit`).set(as('developer')).expect(201);
    const lastSubmission = async () => (await events('voucher.submitted')).at(-1)!.approvalRequestId as string;

    await submit();
    expect(await events('voucher.submitted')).toMatchObject([
      {
        voucherId: created.id,
        status: 'PENDING_APPROVAL',
        approvalRequestId: expect.any(String),
        submittedBy: { type: 'USER', id: ids.developer },
        createdBy: { type: 'USER', id: ids.developer },
      },
    ]);

    // The Owner decides on the submission the event named.
    await ctx
      .http()
      .post(`${consoleVouchers()}/${created.id}/reject`)
      .set(as('owner'))
      .send({ approvalRequestId: await lastSubmission(), reason: 'Too generous' })
      .expect(201);
    await submit();
    await ctx.http().post(`${consoleVouchers()}/${created.id}/withdraw`).set(as('developer')).expect(201);
    expect(await events('voucher.returned')).toMatchObject([
      { status: 'DRAFT', outcome: 'REJECTED', reason: 'Too generous', reviewedById: ids.owner },
      { status: 'DRAFT', outcome: 'WITHDRAWN', reason: null, reviewedById: ids.developer },
    ]);

    await submit();
    await ctx
      .http()
      .post(`${consoleVouchers()}/${created.id}/approve`)
      .set(as('owner'))
      .send({ approvalRequestId: await lastSubmission() })
      .expect(201);
    // Approving starts publishing; it sends nothing of its own.
    expect((await eventTypes(ctx.db)).at(-1)).toBe('voucher.submitted');
    await rewards().markVoucherPublished(created.id, '0xterms-queued');
    expect(await events('voucher.activated')).toMatchObject([
      { voucherId: created.id, activatedBy: { type: 'USER', id: ids.owner } },
    ]);
    expect(await eventTypes(ctx.db)).toEqual([
      'voucher.created',
      'voucher.submitted',
      'voucher.returned',
      'voucher.submitted',
      'voucher.returned',
      'voucher.submitted',
      'voucher.activated',
    ]);
  });

  it('an API key creating ACTIVE while approval is required: created, then submitted', async () => {
    await requireApproval();
    await createByKey(voucher('BYKEY', { status: 'ACTIVE' }));
    expect(await eventTypes(ctx.db)).toEqual(['voucher.created', 'voucher.submitted']);
    expect(await events('voucher.submitted')).toMatchObject([
      { status: 'PENDING_APPROVAL', submittedBy: { type: 'API_CREDENTIAL', id: credentialId } },
    ]);
  });

  it('batches: one created per new voucher, archived per frozen one, created again when a code is reimported', async () => {
    const batches = '/v1/rewards/voucher-batches';
    const first = (
      await ctx
        .http()
        .post(batches)
        .set(key)
        .send({ items: [voucher('B1'), voucher('B2')] })
        .expect(201)
    ).body;
    // Sending the same list again changes nothing, so it records nothing.
    await ctx
      .http()
      .post(batches)
      .set(key)
      .send({ items: [voucher('B1'), voucher('B2')] })
      .expect(201);
    expect(await events('voucher.created')).toMatchObject([
      { code: 'B1', batchId: first.batch.id, status: 'DRAFT' },
      { code: 'B2', batchId: first.batch.id, status: 'DRAFT' },
    ]);

    await ctx.http().post(`${batches}/${first.batch.id}/archive`).set(key).send({}).expect(201);
    expect(await events('voucher.archived')).toMatchObject([
      { code: 'B1', status: 'ARCHIVED' },
      { code: 'B2', status: 'ARCHIVED' },
    ]);

    const second = (
      await ctx
        .http()
        .post(batches)
        .set(key)
        .send({ items: [voucher('B1')] })
        .expect(201)
    ).body;
    expect((await events('voucher.created')).at(-1)).toMatchObject({
      code: 'B1',
      batchId: second.batch.id,
      status: 'DRAFT',
    });
  });

  it('a refused change records nothing', async () => {
    const { id } = await createByKey(voucher('REFUSED', { status: 'DRAFT' }));
    await ctx.http().patch(`${consoleVouchers()}/${id}`).set(as('developer')).send({ status: 'PAUSED' }).expect(403);
    expect(await eventTypes(ctx.db)).toEqual(['voucher.created']);
  });

  it('every event is recorded without an endpoint; with endpoints, each gets it under the same event id', async () => {
    await createByKey(voucher('QUIET', { status: 'DRAFT' }));
    expect(await deliveriesWithEvents(ctx.db)).toEqual([]);

    const endpoints = await ctx.db
      .insert(schema.webhookEndpoints)
      .values([
        { organizationId: orgId, url: 'https://a.example/hook', secret: 'whsec_a' },
        { organizationId: orgId, url: 'https://b.example/hook', secret: 'whsec_b' },
      ])
      .returning();
    const { id } = await createByKey(voucher('LOUD', { status: 'DRAFT' }));

    const [event] = await ctx.db
      .select()
      .from(schema.organizationEvents)
      .where(eq(schema.organizationEvents.type, 'voucher.created'))
      .orderBy(asc(schema.organizationEvents.sequence))
      .offset(1);
    expect(event.payload).toMatchObject({ voucherId: id });
    const deliveries = await deliveriesWithEvents(ctx.db);
    expect(deliveries.map((d) => d.endpointId).sort()).toEqual(endpoints.map((e) => e.id).sort());
    expect(deliveries.every((d) => d.eventId === event.id && d.eventType === 'voucher.created')).toBe(true);
  });
});
