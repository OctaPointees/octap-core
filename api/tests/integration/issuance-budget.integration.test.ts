import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { BudgetTopUpProcessor } from '#domain/organizations/budget-top-up.processor.js';
import type { ProgramsService } from '#domain/programs/programs.service.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import {
  ORGANIZATION_BUDGET_TOP_UP_COMMAND,
  OrganizationsRepository,
} from '#infra/db/repositories/organizations.repository.js';
import { NotFoundException } from '@nestjs/common';
import { stub } from '../helpers/stub.js';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedCredential, seedMember, seedOrganization, seedProgram } from './support/db.js';

describe('issuance budget', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<string, string>;
  const session = (actor: string) => `Bearer ${actor}`;
  const topUpOperations = () =>
    ctx.db
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.commandType, ORGANIZATION_BUDGET_TOP_UP_COMMAND));
  const propose = (amount: unknown, actor = 'owner', platform = false) =>
    ctx
      .http()
      .post(`/v1/${platform ? 'platform' : 'console'}/organizations/${orgId}/change-requests`)
      .set('Authorization', session(actor))
      .send({ requestType: 'BUDGET_TOP_UP', payload: { amount }, reason: 'Campaign next month' });
  const decide = (id: string, decision = 'approve', actor = 'admin') =>
    ctx
      .http()
      .post(`/v1/platform/change-requests/${id}/${decision}`)
      .set('Authorization', session(actor))
      .send({ reason: 'Matches the forecast' });
  const processor = (topUpBudget: ProgramsService['topUpBudget']) =>
    new BudgetTopUpProcessor(
      ctx.app.get(OrganizationsRepository, { strict: false }),
      new OperationsRepository(ctx.db),
      stub<ProgramsService>({ topUpBudget }),
    );

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
    for (const actor of ['owner', 'developer', 'admin', 'outsider']) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
      if (actor === 'owner' || actor === 'developer')
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

  describe('reading', () => {
    const consoleRoute = () => `/v1/console/organizations/${orgId}/budget`;
    const platformRoute = () => `/v1/platform/organizations/${orgId}/budget`;

    it('shows the live amount to members, System Admins and API keys, and no one else', async () => {
      const expected = {
        organizationId: orgId,
        remaining: 1_000_000,
        initialBudget: 1_000_000,
        shards: [{ shardId: `0xbudget0-${orgId}`, remaining: 1_000_000 }],
        recentTopUps: [],
      };
      for (const actor of ['owner', 'developer']) {
        const res = await ctx.http().get(consoleRoute()).set('Authorization', session(actor)).expect(200);
        expect(res.body).toMatchObject(expected);
      }
      await ctx.http().get(consoleRoute()).set('Authorization', session('outsider')).expect(403);
      await ctx.http().get(platformRoute()).set('Authorization', session('admin')).expect(200);
      await ctx.http().get(platformRoute()).set('Authorization', session('owner')).expect(403);

      const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
      const res = await ctx.http().get('/v1/credits/budget').set('Authorization', `Bearer ${rawKey}`).expect(200);
      expect(res.body).toMatchObject(expected);
      const writeOnly = await seedCredential(ctx.db, orgId, { scopes: ['write'] });
      await ctx.http().get('/v1/credits/budget').set('Authorization', `Bearer ${writeOnly.rawKey}`).expect(403);
    });

    it('answers 404 without a program and 503 when the chain cannot be read', async () => {
      ctx.adapters.suiBuilder.budgetShardRemaining.mockRejectedValueOnce(new Error('UNAVAILABLE'));
      await ctx.http().get(platformRoute()).set('Authorization', session('admin')).expect(503);

      await ctx.db.delete(schema.programs).where(eq(schema.programs.organizationId, orgId));
      await ctx.http().get(platformRoute()).set('Authorization', session('admin')).expect(404);
    });
  });

  describe('top-up requests', () => {
    it('lets an Owner propose and only a System Admin approve, queuing one command', async () => {
      await propose(0).expect(400);
      await propose(1.5).expect(400);
      await propose(5000, 'developer').expect(403);
      const request = await propose(5000).expect(201);
      expect(await topUpOperations()).toEqual([]);

      await decide(request.body.id, 'approve', 'owner').expect(403);
      await decide(request.body.id).expect(201);
      await decide(request.body.id).expect(409);

      expect(await topUpOperations()).toMatchObject([
        { tenantId: orgId, status: 'PENDING', payload: { amount: 5000, changeRequestId: request.body.id } },
      ]);
      const record = await ctx.db.query.organizationChangeRequests.findFirst({
        where: eq(schema.organizationChangeRequests.id, request.body.id),
      });
      expect(record).toMatchObject({
        status: 'APPROVED',
        requestedById: ids.owner,
        reviewedById: ids.admin,
        reason: 'Matches the forecast',
      });
    });

    it('queues nothing when rejected or when there is no active program', async () => {
      const rejected = await propose(5000, 'admin', true).expect(201);
      await decide(rejected.body.id, 'reject').expect(201);
      const stranded = await propose(5000).expect(201);
      await ctx.db.delete(schema.programs).where(eq(schema.programs.organizationId, orgId));
      await decide(stranded.body.id).expect(409);
      expect(await topUpOperations()).toEqual([]);
    });

    it('executes an approved top-up and shows it, and never retries an unknown outcome', async () => {
      const request = await propose(5000).expect(201);
      await decide(request.body.id).expect(201);
      const operations = new OperationsRepository(ctx.db);
      const [job] = await operations.claimNextPending([ORGANIZATION_BUDGET_TOP_UP_COMMAND]);
      const topUpBudget = vi.fn(async () => []);
      await processor(topUpBudget).process(job);
      expect(topUpBudget).toHaveBeenCalledWith({ organizationId: orgId, amount: 5000 });
      expect(await topUpOperations()).toMatchObject([{ status: 'SUBMITTED' }]);
      const budget = await ctx
        .http()
        .get(`/v1/console/organizations/${orgId}/budget`)
        .set('Authorization', session('owner'));
      expect(budget.body.recentTopUps).toMatchObject([{ operationId: job.id, amount: 5000, status: 'SUBMITTED' }]);

      const second = await propose(700).expect(201);
      await decide(second.body.id).expect(201);
      const [unknown] = await operations.claimNextPending([ORGANIZATION_BUDGET_TOP_UP_COMMAND]);
      await processor(async () => {
        throw new Error('connection lost');
      }).process(unknown);
      expect((await topUpOperations()).find((op) => op.id === unknown.id)?.status).toBe('UNKNOWN');
      expect(await operations.claimNextPending([ORGANIZATION_BUDGET_TOP_UP_COMMAND])).toEqual([]);
    });

    it('fails a top-up without touching the chain when the program is gone', async () => {
      const request = await propose(5000).expect(201);
      await decide(request.body.id).expect(201);
      const [job] = await new OperationsRepository(ctx.db).claimNextPending([ORGANIZATION_BUDGET_TOP_UP_COMMAND]);
      await processor(async () => {
        throw new NotFoundException('gone');
      }).process(job);
      expect(await topUpOperations()).toMatchObject([{ status: 'FAILED' }]);
    });
  });

  describe('earn', () => {
    let memberId: string;
    let auth: { authorization: string };
    const earn = (idempotencyKey: string) =>
      ctx
        .http()
        .post('/v1/credits/earn')
        .set(auth)
        .send({ organizationEndUserId: memberId, purchaseAmount: 100_000, idempotencyKey });

    beforeEach(async () => {
      memberId = (await seedMember(ctx.db, orgId)).memberId;
      auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    });

    it('refuses what the shard cannot cover, and still accepts when the chain cannot be read', async () => {
      ctx.adapters.suiBuilder.budgetShardRemaining.mockResolvedValueOnce(999n);
      await earn('too-big').expect(422);
      expect(await ctx.db.select().from(schema.loyaltyTransactions)).toEqual([]);

      ctx.adapters.suiBuilder.budgetShardRemaining.mockResolvedValueOnce(1000n);
      await earn('exact-fit').expect(201);

      ctx.adapters.suiBuilder.budgetShardRemaining.mockRejectedValueOnce(new Error('UNAVAILABLE'));
      await earn('chain-down').expect(201);
    });

    it('sends one failure webhook, and a retry under the failed key reports the failure', async () => {
      await ctx
        .http()
        .post('/v1/webhooks/endpoints')
        .set({ authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['admin'] })).rawKey}` })
        .send({ url: 'https://merchant.test/hooks' })
        .expect(201);
      const accepted = await earn('will-fail').expect(201);
      const credits = new CreditsRepository(ctx.db);
      const failure = {
        loyaltyTransactionId: accepted.body.transactionId,
        organizationEndUserId: memberId,
        failureCode: 'BUDGET_EXHAUSTED' as const,
      };
      await credits.failEarnOnChain(failure);
      await credits.failEarnOnChain(failure);

      const failed = (await ctx.db.select().from(schema.webhookDeliveries)).filter(
        (delivery) => delivery.eventType === 'credits.earn.failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toEqual({
        transactionId: accepted.body.transactionId,
        organizationEndUserId: memberId,
        purchaseAmount: 100_000,
        estimatedPoints: 1000,
        failureCode: 'BUDGET_EXHAUSTED',
      });
      expect((await earn('will-fail').expect(201)).body).toMatchObject({ status: 'FAILED', pointsEarned: null });
      expect((await earn('new-key').expect(201)).body.status).toBe('PENDING');
    });
  });
});
