import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { createTestApp } from '../support/app.js';
import { resetDb, schema, seedCredential, seedMember, seedOrganization, seedProgram } from '../support/db.js';

const ACTORS = ['owner', 'developer'] as const;
type Actor = (typeof ACTORS)[number];

describe('audit log: who did what, durable, Owner-readable (OCT-333)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<Actor, string>;
  const google = {
    verify: async (token: string) => {
      if (!(ACTORS as readonly string[]).includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: `${token} name`,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const consolePath = (path: string) => `/v1/console/organizations/${orgId}${path}`;
  const auditRows = () => ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, orgId));
  const readLog = (actor: Actor, query: Record<string, string> = {}) =>
    ctx.http().get(consolePath('/audit-log')).query(query).set(as(actor));

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
    ]);
  });

  it('records a console user’s API key changes with the user and the request id', async () => {
    const issued = await ctx
      .http()
      .post(consolePath('/api-credentials'))
      .set(as('developer'))
      .send({ name: 'till' })
      .expect(201);
    await ctx
      .http()
      .patch(consolePath(`/api-credentials/${issued.body.id}`))
      .set(as('owner'))
      .send({ name: 'till 2' })
      .expect(200);
    await ctx
      .http()
      .delete(consolePath(`/api-credentials/${issued.body.id}`))
      .set(as('owner'))
      .expect(200);

    const rows = await auditRows();
    expect(rows.map((row) => row.action).sort()).toEqual(['api_key.issued', 'api_key.renamed', 'api_key.revoked']);
    const issuedRow = rows.find((row) => row.action === 'api_key.issued')!;
    expect(issuedRow).toMatchObject({
      actorType: 'USER',
      actorId: ids.developer,
      targetType: 'api_key',
      targetId: issued.body.id,
      requestId: issued.headers['x-request-id'],
    });
    expect(issuedRow.changes).toMatchObject({ name: 'till', environment: 'LIVE' });
    expect(issuedRow.changes).not.toHaveProperty('rawKey');
    expect(rows.find((row) => row.action === 'api_key.renamed')!.changes).toEqual({
      name: { from: 'till', to: 'till 2' },
    });
  });

  it('records an API key’s writes through the outbox, as the key, and nothing for system work', async () => {
    await seedProgram(ctx.db, orgId);
    const { memberId } = await seedMember(ctx.db, orgId);
    const key = await seedCredential(ctx.db, orgId);
    const earned = await ctx
      .http()
      .post('/v1/credits/earn')
      .set({ authorization: `Bearer ${key.rawKey}` })
      .send({ organizationEndUserId: memberId, purchaseAmount: 100_000, idempotencyKey: 'e1' })
      .expect(201);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'credits.earned',
      actorType: 'CREDENTIAL',
      actorId: key.credential.id,
      targetType: 'loyalty_transaction',
      targetId: earned.body.transactionId,
    });
    const [event] = await ctx.db.select().from(schema.organizationEvents);
    expect(rows[0].changes).toEqual({ eventId: event.id });
  });

  it('records member blocks, staff suspension, webhook endpoints and settings, with no personal data', async () => {
    const { memberId } = await seedMember(ctx.db, orgId);
    const member = (body: Record<string, unknown>) =>
      ctx
        .http()
        .patch(consolePath(`/members/${memberId}`))
        .set(as('owner'))
        .send(body)
        .expect(200);
    await member({ status: 'BLOCKED' });
    await member({ status: 'BLOCKED' }); // nothing changed: no row
    await member({ status: 'ACTIVE' });
    const [invitation] = await ctx.db
      .insert(schema.invitations)
      .values({
        organizationId: orgId,
        invitedById: ids.owner,
        email: 'developer@example.com',
        role: 'BUSINESS_DEVELOPER',
        token: `t-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const staff = (status: string) =>
      ctx
        .http()
        .patch(consolePath(`/staff/${ids.developer}`))
        .set(as('owner'))
        .send({ status })
        .expect(200);
    await staff('SUSPENDED');
    await staff('SUSPENDED'); // already suspended: no second row
    // A token in the path must never reach the permanent log.
    const endpoint = await ctx
      .http()
      .post(consolePath('/webhooks/endpoints'))
      .set(as('owner'))
      .send({ url: 'https://hooks.example.com/services/T000/B000/SECRET-TOKEN' })
      .expect(201);
    const disable = () =>
      ctx
        .http()
        .post(consolePath(`/webhooks/endpoints/${endpoint.body.id}/disable`))
        .set(as('owner'))
        .expect(201);
    await disable();
    await disable(); // already disabled: no second row

    const rows = await auditRows();
    expect(rows.map((row) => row.action).sort()).toEqual([
      'invitation.revoked',
      'member.blocked',
      'member.unblocked',
      'staff.suspended',
      'webhook_endpoint.disabled',
      'webhook_endpoint.registered',
    ]);
    expect(rows.find((row) => row.action === 'member.blocked')!.changes).toEqual({
      fields: ['status'],
      status: { from: 'ACTIVE', to: 'BLOCKED' },
    });
    expect(rows.find((row) => row.action === 'invitation.revoked')).toMatchObject({
      targetId: invitation.id,
      changes: { reason: 'staff_suspended' },
    });
    expect(rows.find((row) => row.action === 'webhook_endpoint.registered')!.changes).toEqual({
      origin: 'https://hooks.example.com',
    });
    expect(rows.every((row) => row.actorType === 'USER' && row.actorId === ids.owner)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('developer@example.com');
    expect(JSON.stringify(rows)).not.toContain('SECRET-TOKEN');
  });

  it('calls a pending member activated an update, not an unblock', async () => {
    const { memberId } = await seedMember(ctx.db, orgId);
    await ctx.db
      .update(schema.organizationEndUsers)
      .set({ status: 'PENDING_VERIFICATION' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    await ctx
      .http()
      .patch(consolePath(`/members/${memberId}`))
      .set(as('owner'))
      .send({ status: 'ACTIVE' })
      .expect(200);
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'member.updated',
      changes: { fields: ['status'], status: { from: 'PENDING_VERIFICATION', to: 'ACTIVE' } },
    });
  });

  it('records a voucher edit by field name, also when its status stays the same', async () => {
    await seedProgram(ctx.db, orgId);
    const vouchers = consolePath('/vouchers');
    const created = await ctx
      .http()
      .post(vouchers)
      .set(as('developer'))
      .send({ code: 'coffee', title: 'Free coffee', discountType: 'FREE_ITEM', pointsCost: 100, totalSupply: 10 })
      .expect(201);
    await ctx
      .http()
      .patch(`${vouchers}/${created.body.id}`)
      .set(as('developer'))
      .send({ totalSupply: 20, title: 'Free coffee' })
      .expect(200);
    const updated = (await auditRows()).filter((row) => row.action === 'voucher.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      actorType: 'USER',
      actorId: ids.developer,
      targetType: 'voucher',
      targetId: created.body.id,
      changes: { fields: ['totalSupply'] },
    });
  });

  it('records a webhook test ping, which has its own writer, with its event and delivery', async () => {
    const endpoint = await ctx
      .http()
      .post(consolePath('/webhooks/endpoints'))
      .set(as('owner'))
      .send({ url: 'https://hooks.example.com/octap' })
      .expect(201);
    await ctx
      .http()
      .post(consolePath(`/webhooks/endpoints/${endpoint.body.id}/test`))
      .set(as('owner'))
      .expect(201);

    const [tested] = (await auditRows()).filter((row) => row.action === 'webhook_endpoint.tested');
    const [event] = await ctx.db.select().from(schema.organizationEvents);
    const [delivery] = await ctx.db.select().from(schema.webhookDeliveries);
    expect(tested).toMatchObject({
      actorType: 'USER',
      actorId: ids.owner,
      targetType: 'webhook_endpoint',
      targetId: endpoint.body.id,
      changes: { eventId: event.id, deliveryId: delivery.id },
    });
  });

  it('records a refund policy publication with its version', async () => {
    const body = {
      allowUnused: true,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: 30,
      reason: 'Customer service policy',
    };
    const published = await ctx.http().put(consolePath('/refund-policy')).set(as('owner')).send(body).expect(200);
    await ctx.http().put(consolePath('/refund-policy')).set(as('owner')).send(body).expect(200);
    const rows = (await auditRows()).filter((row) => row.action === 'refund_policy.published');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.changes)).toEqual(
      expect.arrayContaining([{ version: { from: null, to: 1 } }, { version: { from: 1, to: 2 } }]),
    );
    expect(rows.map((row) => row.targetId).sort()).toEqual([String(published.body.version), '2'].sort());
    expect(rows.every((row) => row.actorType === 'USER' && row.actorId === ids.owner)).toBe(true);
  });

  it('lets only the Owner read it, newest first, with labels, filters and paging', async () => {
    for (const name of ['a', 'b', 'c']) {
      await ctx.http().post(consolePath('/api-credentials')).set(as('owner')).send({ name }).expect(201);
    }
    const page = (await readLog('owner', { limit: '2' }).expect(200)).body;
    expect(page.items).toHaveLength(2);
    const [newest] = (await auditRows()).sort((a, b) => b.sequence - a.sequence);
    expect(page.items[0].id).toBe(newest.id);
    // Opaque: the cursor is a row id, and the shared sequence is never on the wire.
    expect(page.nextCursor).toBe(page.items[1].id);
    expect(page.items[0]).not.toHaveProperty('sequence');
    expect(page.items[0]).toMatchObject({
      action: 'api_key.issued',
      actor: { type: 'USER', id: ids.owner, label: 'owner name' },
      target: { type: 'api_key' },
    });
    const next = (await readLog('owner', { limit: '2', cursor: page.nextCursor }).expect(200)).body;
    expect(next).toMatchObject({ nextCursor: null });
    expect(next.items).toHaveLength(1);

    expect((await readLog('owner', { action: 'api_key.' }).expect(200)).body.items).toHaveLength(3);
    expect((await readLog('owner', { action: 'member.' }).expect(200)).body.items).toHaveLength(0);
    expect((await readLog('owner', { actorType: 'CREDENTIAL' }).expect(200)).body.items).toHaveLength(0);
    await readLog('owner', { actorType: 'ROBOT' }).expect(400);
    await readLog('owner', { from: 'Nov 1 2026' }).expect(400);
    await readLog('owner', { from: '2026-11-01T00:00:00' }).expect(400); // no offset
    await readLog('owner', { from: '2026-11-01T00:00:00Z' }).expect(200);
    await readLog('developer').expect(403);
  });

  it('is append-only: no role can change or delete a row', async () => {
    // drizzle wraps the Postgres error: the trigger's message is on its cause.
    const appendOnly = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await ctx.http().post(consolePath('/api-credentials')).set(as('owner')).send({ name: 'k' }).expect(201);
    const [row] = await auditRows();
    await expect(
      ctx.db.update(schema.auditLog).set({ action: 'tampered' }).where(eq(schema.auditLog.id, row.id)),
    ).rejects.toMatchObject(appendOnly);
    await expect(ctx.db.delete(schema.auditLog).where(eq(schema.auditLog.id, row.id))).rejects.toMatchObject(
      appendOnly,
    );
    await expect(ctx.db.execute(sql`truncate table audit_log`)).rejects.toMatchObject(appendOnly);
  });

  it('never shows another organization’s rows', async () => {
    const other = (await seedOrganization(ctx.db)).id;
    await ctx.db.insert(schema.auditLog).values({
      organizationId: other,
      actorType: 'SYSTEM',
      action: 'organization.settings_updated',
      targetType: 'organization',
      targetId: other,
      requestId: randomUUID(),
    });
    expect((await readLog('owner').expect(200)).body.items).toHaveLength(0);
  });
});
