import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { EarnRateChangeProcessor } from '#domain/organizations/earn-rate-change.processor.js';
import { ProgramsService } from '#domain/programs/programs.service.js';
import type { ProgramAdminClient } from '#infra/clients/sui/program-admin.client.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import {
  ORGANIZATION_EARN_RATE_CHANGE_COMMAND,
  OrganizationsRepository,
} from '#infra/db/repositories/organizations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { stub } from '../helpers/stub.js';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization, seedProgram } from './support/db.js';

/** OCT-341: an Owner asks, a System Admin approves, the worker rotates the policy. */
describe('earn-rate change requests', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<string, string>;
  const session = (actor: string) => `Bearer ${actor}`;
  const earnRateOperations = () =>
    ctx.db
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.commandType, ORGANIZATION_EARN_RATE_CHANGE_COMMAND));
  const program = async () =>
    (await ctx.db.query.programs.findFirst({ where: eq(schema.programs.organizationId, orgId) }))!;
  const propose = (payload: unknown, actor = 'owner') =>
    ctx
      .http()
      .post(`/v1/console/organizations/${orgId}/change-requests`)
      .set('Authorization', session(actor))
      .send({ requestType: 'UPDATE_EARN_RATE', payload, reason: 'Matching a competitor' });
  const decide = (id: string, decision = 'approve', actor = 'admin') =>
    ctx
      .http()
      .post(`/v1/platform/change-requests/${id}/${decision}`)
      .set('Authorization', session(actor))
      .send({ reason: 'Reviewed' });
  const processor = (rotatePolicy: ProgramAdminClient['rotatePolicy']) =>
    new EarnRateChangeProcessor(
      ctx.app.get(OrganizationsRepository, { strict: false }),
      new OperationsRepository(ctx.db),
      new ProgramsService(new ProgramsRepository(ctx.db), stub<ProgramAdminClient>({ rotatePolicy })),
    );
  const claim = async () =>
    (await new OperationsRepository(ctx.db).claimNextPending([ORGANIZATION_EARN_RATE_CHANGE_COMMAND]))[0];

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
    ids = {};
    orgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    for (const actor of ['owner', 'developer', 'admin']) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
      if (actor !== 'admin')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: ids[actor],
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
    }
    await ctx.db
      .update(schema.systemUsers)
      .set({ systemRole: 'SYSTEM_ADMIN' })
      .where(eq(schema.systemUsers.id, ids.admin));
  });

  it('validates the proposal: range, fields, Owner only, a real change, one at a time', async () => {
    await propose({ earnBps: -1 }).expect(400);
    await propose({ earnBps: 10001 }).expect(400);
    await propose({ earnBps: 1.5 }).expect(400);
    await propose({ earnBps: 200, amount: 5 }).expect(400);
    await propose({ earnBps: 200 }, 'developer').expect(403);
    await propose({ earnBps: 100 }).expect(400); // the seeded rate already
    const request = await propose({ earnBps: 200 }).expect(201);
    expect(request.body).toMatchObject({
      requestType: 'UPDATE_EARN_RATE',
      payload: { earnBps: 200, expectedPolicyVersion: 1, previousEarnBps: 100 },
    });
    await propose({ earnBps: 300 }).expect(409);
    expect(await earnRateOperations()).toEqual([]);
  });

  it('refuses a proposal without an active program', async () => {
    await ctx.db.delete(schema.programs).where(eq(schema.programs.organizationId, orgId));
    await propose({ earnBps: 200 }).expect(409);
  });

  it('runs propose → approve → worker, rotating the policy and updating the row in place', async () => {
    const request = await propose({ earnBps: 250 }).expect(201);
    await decide(request.body.id, 'approve', 'owner').expect(403);
    await decide(request.body.id).expect(201);
    expect(await earnRateOperations()).toMatchObject([
      {
        tenantId: orgId,
        status: 'PENDING',
        payload: { earnBps: 250, fromPolicyVersion: 1, changeRequestId: request.body.id },
      },
    ]);
    // Nothing changes before the worker runs: approval never applies the effect inline.
    expect(await program()).toMatchObject({ earnBps: 100, policyVersion: 1 });

    const before = await program();
    const rotatePolicy = vi.fn(async () => ({ policyVersionId: '0xpolicy-v2' }));
    await processor(rotatePolicy).process(await claim());
    expect(rotatePolicy).toHaveBeenCalledWith({
      adminCapId: before.adminCapId,
      programId: before.programControlId,
      version: 2,
      earnBps: 250,
      expiryMs: Number(before.expiryMs),
    });
    expect(await earnRateOperations()).toMatchObject([{ status: 'SUBMITTED' }]);
    expect(await program()).toMatchObject({
      id: before.id,
      earnBps: 250,
      policyVersion: 2,
      policyVersionId: '0xpolicy-v2',
      issuerCapId: before.issuerCapId,
    });
  });

  it('refuses an approval once the policy moved since the proposal', async () => {
    const request = await propose({ earnBps: 250 }).expect(201);
    await ctx.db.update(schema.programs).set({ policyVersion: 2 }).where(eq(schema.programs.organizationId, orgId));
    await decide(request.body.id).expect(409);
    expect(await earnRateOperations()).toEqual([]);
  });

  it('never queues a second change while one is unsettled, and never retries an unknown outcome', async () => {
    const first = await propose({ earnBps: 250 }).expect(201);
    await decide(first.body.id).expect(201);
    await processor(async () => {
      throw new Error('connection lost');
    }).process(await claim());
    expect(await earnRateOperations()).toMatchObject([{ status: 'UNKNOWN' }]);
    expect(await claim()).toBeUndefined();
    expect(await program()).toMatchObject({ earnBps: 100, policyVersion: 1 });

    const second = await propose({ earnBps: 300 }).expect(201);
    await decide(second.body.id).expect(409);
    expect(await earnRateOperations()).toHaveLength(1);
  });

  it('fails without touching the chain when the program is gone or the command is stale', async () => {
    const request = await propose({ earnBps: 250 }).expect(201);
    await decide(request.body.id).expect(201);
    const job = await claim();
    await ctx.db.update(schema.programs).set({ policyVersion: 5 }).where(eq(schema.programs.organizationId, orgId));
    const rotatePolicy = vi.fn(async () => ({ policyVersionId: '0xnever' }));
    await processor(rotatePolicy).process(job);
    expect(rotatePolicy).not.toHaveBeenCalled();
    expect(await earnRateOperations()).toMatchObject([{ status: 'FAILED' }]);

    await ctx.db.update(schema.programs).set({ policyVersion: 1 }).where(eq(schema.programs.organizationId, orgId));
    const again = await propose({ earnBps: 400 }).expect(201);
    await decide(again.body.id).expect(201);
    const gone = await claim();
    await ctx.db.delete(schema.programs).where(eq(schema.programs.organizationId, orgId));
    await processor(rotatePolicy).process(gone);
    expect(rotatePolicy).not.toHaveBeenCalled();
    expect((await earnRateOperations()).find((op) => op.id === gone.id)?.status).toBe('FAILED');
  });
});
