import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
    await ctx
      .http()
      .patch(consolePath(`/members/${memberId}`))
      .set(as('owner'))
      .send({ status: 'BLOCKED' })
      .expect(200);
    await ctx
      .http()
      .patch(consolePath(`/staff/${ids.developer}`))
      .set(as('owner'))
      .send({ status: 'SUSPENDED' })
      .expect(200);
    const endpoint = await ctx
      .http()
      .post(consolePath('/webhooks/endpoints'))
      .set(as('owner'))
      .send({ url: 'https://hooks.example.com/octap' })
      .expect(201);
    await ctx
      .http()
      .post(consolePath(`/webhooks/endpoints/${endpoint.body.id}/disable`))
      .set(as('owner'))
      .expect(201);

    const rows = await auditRows();
    expect(rows.map((row) => row.action).sort()).toEqual([
      'member.blocked',
      'staff.suspended',
      'webhook_endpoint.disabled',
      'webhook_endpoint.registered',
    ]);
    expect(rows.find((row) => row.action === 'member.blocked')!.changes).toEqual({
      fields: ['status'],
      status: { from: 'ACTIVE', to: 'BLOCKED' },
    });
    expect(rows.every((row) => row.actorType === 'USER' && row.actorId === ids.owner)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('developer@example.com');
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
    expect(page.items[0].sequence).toBeGreaterThan(page.items[1].sequence);
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
