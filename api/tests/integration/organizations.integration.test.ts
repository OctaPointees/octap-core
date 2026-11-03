import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization } from './support/db.js';
import {
  OrganizationsRepository,
  ORGANIZATION_PROVISION_COMMAND,
} from '#infra/db/repositories/organizations.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { ProgramsService } from '#domain/programs/programs.service.js';
import { OrganizationProvisioningProcessor } from '#domain/organizations/provisioning.processor.js';
import { OrganizationProvisioningWorker } from '#domain/organizations/provisioning.worker.js';
import type { ProgramAdminClient } from '#infra/clients/sui/program-admin.client.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';

describe('organization management and durable provisioning', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<string, string>;
  let orgId: string;
  const input = { earnBps: 100, expiryDays: 365, totalBudget: 10000, shardCount: 1, idempotencyKey: 'provision-first' };
  const auth = (actor = 'admin') => `Bearer ${actor}`;
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
    for (const actor of ['owner', 'admin'])
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
    await ctx.db
      .update(schema.systemUsers)
      .set({ systemRole: 'SYSTEM_ADMIN' })
      .where(eq(schema.systemUsers.id, ids.admin));
    orgId = (await seedOrganization(ctx.db, { name: 'Existing Tenant', slug: 'existing-tenant' })).id;
  });
  const enqueue = (body: object = input, actor = 'admin') =>
    ctx.http().post(`/v1/platform/organizations/${orgId}/provision`).set('Authorization', auth(actor)).send(body);
  const create = (overrides = {}) =>
    ctx
      .http()
      .post('/v1/platform/organizations')
      .set('Authorization', auth())
      .send({
        ownerUserId: ids.owner,
        name: 'Second Tenant',
        slug: 'second-tenant',
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Owner Person',
        ...overrides,
      });
  function processor(
    provision = vi.fn(async () => ({
      programId: '0xprogram',
      adminCapId: '0xadmin',
      policyVersionId: '0xpolicy',
      issuerCapId: '0xissuer',
      operationShardIds: ['0xop'],
      budgetShardIds: ['0xbudget'],
    })),
    issuer = vi.fn(async () => '0xrecipient'),
  ) {
    return {
      provision,
      issuer,
      service: new OrganizationProvisioningProcessor(
        new OrganizationsRepository(ctx.db),
        new OperationsRepository(ctx.db),
        new ProgramsService(new ProgramsRepository(ctx.db), {
          provisionProgram: provision,
        } as unknown as ProgramAdminClient),
        new ProgramsRepository(ctx.db),
        { issuerAddress: issuer } as unknown as SuiClientService,
      ),
    };
  }
  it('creates an admin-attributed application and approves the explicitly selected initial Owner', async () => {
    const request = await create().expect(201);
    const pending = await ctx
      .http()
      .get('/v1/platform/organizations?status=PENDING_APPROVAL&q=Second')
      .set('Authorization', auth())
      .expect(200);
    expect(pending.body.items).toHaveLength(1);
    const id = pending.body.items[0].id;
    await ctx.http().get('/v1/organizations/resolve/second-tenant').expect(404);
    await ctx
      .http()
      .post(`/v1/platform/change-requests/${request.body.id}/approve`)
      .set('Authorization', auth())
      .send({ reason: 'Verified application' })
      .expect(201);
    const owner = await ctx.http().get('/v1/console/me').set('Authorization', auth('owner')).expect(200);
    expect(owner.body.organizations[0]).toMatchObject({ organizationId: id, persona: 'BUSINESS_OWNER' });
    expect((await ctx.http().get('/v1/console/me').set('Authorization', auth())).body.organizations).toEqual([]);
    const record = await ctx.db.query.organizationChangeRequests.findFirst({
      where: eq(schema.organizationChangeRequests.id, request.body.id),
    });
    expect(record?.requestedById).toBe(ids.admin);
    const resolution = await ctx.http().get('/v1/organizations/resolve/second-tenant').expect(200);
    expect(Object.keys(resolution.body).sort()).toEqual(['name', 'organizationId', 'slug']);
    await create().expect(409);
    const page = await ctx.http().get('/v1/platform/organizations?limit=1').set('Authorization', auth()).expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeTruthy();
    await ctx
      .http()
      .get(`/v1/platform/organizations?cursor=${page.body.nextCursor}`)
      .set('Authorization', auth())
      .expect(200);
    await ctx.http().get(`/v1/platform/organizations/${id}`).set('Authorization', auth()).expect(200);
  });
  it('creates and provisions two independent organizations entirely through the API and worker', async () => {
    const newIds: string[] = [];
    for (const slug of ['tenant-first', 'tenant-second']) {
      const request = await create({ slug, name: slug }).expect(201);
      await ctx
        .http()
        .post(`/v1/platform/change-requests/${request.body.id}/approve`)
        .set('Authorization', auth())
        .send({ reason: 'Approved tenant' })
        .expect(201);
      const resolved = await ctx.http().get(`/v1/organizations/resolve/${slug}`).expect(200);
      newIds.push(resolved.body.organizationId);
      await ctx
        .http()
        .post(`/v1/platform/organizations/${resolved.body.organizationId}/provision`)
        .set('Authorization', auth())
        .send(input)
        .expect(201);
    }
    let sequence = 0;
    const worker = processor(
      vi.fn(async () => {
        sequence++;
        return {
          programId: `0xprogram${sequence}`,
          adminCapId: `0xadmin${sequence}`,
          policyVersionId: `0xpolicy${sequence}`,
          issuerCapId: `0xissuer${sequence}`,
          operationShardIds: [`0xop${sequence}`],
          budgetShardIds: [`0xbudget${sequence}`],
        };
      }),
    );
    const jobs = await new OperationsRepository(ctx.db).claimNextPending([ORGANIZATION_PROVISION_COMMAND]);
    for (const job of jobs) await worker.service.process(job);
    const first = await ctx
      .http()
      .get(`/v1/platform/organizations/${newIds[0]}`)
      .set('Authorization', auth())
      .expect(200);
    const second = await ctx
      .http()
      .get(`/v1/platform/organizations/${newIds[1]}`)
      .set('Authorization', auth())
      .expect(200);
    expect(first.body.programStatus).toBe('ACTIVE');
    expect(second.body.programStatus).toBe('ACTIVE');
    expect(first.body.programControlId).not.toBe(second.body.programControlId);
    expect(
      (await ctx.http().get('/v1/console/me').set('Authorization', auth('owner'))).body.organizations,
    ).toHaveLength(2);
  });
  it('enforces platform permissions, validates inputs, and exposes only Google-bound owner choices', async () => {
    await enqueue(input, 'owner').expect(403);
    await ctx.http().get('/v1/platform/organizations').set('Authorization', auth('owner')).expect(403);
    await ctx.http().get('/v1/platform/owner-candidates?q=owner').set('Authorization', auth('owner')).expect(403);
    const owners = await ctx
      .http()
      .get('/v1/platform/owner-candidates?q=owner')
      .set('Authorization', auth())
      .expect(200);
    expect(owners.body[0]).toEqual({ id: ids.owner, email: 'owner@example.com', fullName: 'owner' });
    await ctx.http().get('/v1/platform/owner-candidates?q=x').set('Authorization', auth()).expect(400);
    const [legacy] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: 'legacy@example.com', fullName: 'Legacy' })
      .returning();
    await create({ ownerUserId: legacy.id }).expect(400);
    await create({ ownerUserId: 'bad' }).expect(400);
    for (const query of ['limit=0', 'status=BAD', 'cursor=bad', `q=${'x'.repeat(161)}`])
      await ctx.http().get(`/v1/platform/organizations?${query}`).set('Authorization', auth()).expect(400);
    await ctx
      .http()
      .get('/v1/platform/organizations/00000000-0000-4000-8000-000000000000')
      .set('Authorization', auth())
      .expect(404);
    await ctx.http().get('/v1/organizations/resolve/BAD').expect(400);
    await enqueue({ ...input, issuerRecipient: 'attacker' }).expect(400);
    await enqueue({ ...input, shardCount: 0 }).expect(400);
    await enqueue({ ...input, idempotencyKey: 'x' }).expect(400);
  });
  it('accepts one durable command, replays the same key, and rejects conflicting or parallel provisioning', async () => {
    const results = await Promise.all([enqueue(), enqueue()]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body.operationId).toBe(results[1].body.operationId);
    await enqueue({ ...input, totalBudget: 20000 }).expect(409);
    await enqueue({ ...input, idempotencyKey: 'another-command' }).expect(409);
    const detail = await ctx.http().get(`/v1/platform/organizations/${orgId}`).set('Authorization', auth()).expect(200);
    expect(detail.body.provisioning).toMatchObject({ status: 'PENDING', operationId: results[0].body.operationId });
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await enqueue().expect(409);
    await ctx.http().get('/v1/organizations/resolve/existing-tenant').expect(404);
  });
  it('provisions through the worker with real persistence and one fake chain boundary', async () => {
    await enqueue().expect(201);
    const worker = processor();
    const jobs = await new OperationsRepository(ctx.db).claimNextPending([ORGANIZATION_PROVISION_COMMAND]);
    await worker.service.process(jobs[0]);
    expect(worker.provision).toHaveBeenCalledOnce();
    expect(worker.provision).toHaveBeenCalledWith(
      expect.objectContaining({ issuerRecipient: '0xrecipient', expiryMs: 365 * 86400000 }),
    );
    const detail = await ctx.http().get(`/v1/platform/organizations/${orgId}`).set('Authorization', auth()).expect(200);
    expect(detail.body).toMatchObject({
      programStatus: 'ACTIVE',
      programControlId: '0xprogram',
      provisioning: { status: 'SUBMITTED' },
    });
    await enqueue({ ...input, idempotencyKey: 'another-command' }).expect(409);
  });
  it('allows retry after a pre-chain prerequisite failure, but never retries an unknown chain outcome', async () => {
    await enqueue().expect(201);
    const operations = new OperationsRepository(ctx.db);
    const [job] = await operations.claimNextPending([ORGANIZATION_PROVISION_COMMAND]);
    const unavailable = processor(
      undefined,
      vi.fn(async () => {
        throw new Error('Missing signer');
      }),
    );
    await unavailable.service.process(job);
    expect(unavailable.provision).not.toHaveBeenCalled();
    expect((await ctx.db.query.operations.findFirst({ where: eq(schema.operations.id, job.id) }))?.status).toBe(
      'FAILED',
    );
    await enqueue({ ...input, idempotencyKey: 'retry-after-failure' }).expect(201);
    const [retry] = await operations.claimNextPending([ORGANIZATION_PROVISION_COMMAND]);
    const partial = processor(
      vi.fn(async () => {
        throw new Error('Network lost after a possible first chain stage');
      }),
    );
    await partial.service.process(retry);
    expect((await ctx.db.query.operations.findFirst({ where: eq(schema.operations.id, retry.id) }))?.status).toBe(
      'UNKNOWN',
    );
    await enqueue({ ...input, idempotencyKey: 'unsafe-third-attempt' }).expect(409);
    expect(await ctx.db.select().from(schema.programs)).toEqual([]);
  });
  it('recovers abandoned worker claims as UNKNOWN and refuses to mint them again', async () => {
    await enqueue().expect(201);
    const ops = new OperationsRepository(ctx.db);
    const [job] = await ops.claimNextPending([ORGANIZATION_PROVISION_COMMAND]);
    await ctx.db
      .update(schema.operations)
      .set({ updatedAt: new Date(Date.now() - 31 * 60000) })
      .where(eq(schema.operations.id, job.id));
    const process = processor();
    const worker = new OrganizationProvisioningWorker(ops, process.service);
    await worker.pollOnce();
    expect(process.provision).not.toHaveBeenCalled();
    expect((await ctx.db.query.operations.findFirst({ where: eq(schema.operations.id, job.id) }))?.status).toBe(
      'UNKNOWN',
    );
  });
});
