import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LicenseEntitlements } from '@octap/contracts';
import { McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import { createTestApp } from './support/app.js';
import {
  resetDb,
  schema,
  seedCredential,
  seedLicense,
  seedLicensePlans,
  seedMember,
  seedOrganization,
  seedProgram,
} from './support/db.js';

/** Every feature, and limits a test can reach. */
const ALL: LicenseEntitlements['features'] = [
  'voucher.batches',
  'voucher.approval',
  'webhooks',
  'mcp',
  'assistant',
  'sandbox',
];

describe('license enforcement (OCT-329, part 2)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<string, string>;
  let plans: Awaited<ReturnType<typeof seedLicensePlans>>;
  const bearer = (actor: string) => ({ Authorization: `Bearer ${actor}` });

  /** Grants a license with these entitlements, on the Growth plan's row. */
  const license = (entitlements: {
    features?: LicenseEntitlements['features'];
    limits?: Partial<LicenseEntitlements['limits']>;
  }) =>
    seedLicense(ctx.db, orgId, {
      ...plans.GROWTH,
      entitlements: {
        features: entitlements.features ?? ALL,
        limits: {
          transactionsMonthly: null,
          members: null,
          apiKeys: null,
          teamMembers: null,
          ...entitlements.limits,
        },
      },
    });
  const usageRow = async () => (await ctx.db.select().from(schema.licenseUsage))[0];
  const thresholdEvents = async () =>
    (await ctx.db.select().from(schema.organizationEvents))
      .filter((event) => event.type === 'license.usage_threshold')
      .map((event) => (event.payload as { threshold: number }).threshold);

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
    plans = await seedLicensePlans(ctx.db);
    ids = {};
    orgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    for (const actor of ['owner', 'developer', 'outsider', 'newdev']) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
      if (actor === 'owner' || actor === 'developer')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: ids[actor],
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
    }
  });

  describe('transactions per license month', () => {
    let memberId: string;
    let auth: { authorization: string };
    const earn = (key: string) =>
      ctx
        .http()
        .post('/v1/credits/earn')
        .set(auth)
        .send({ organizationEndUserId: memberId, purchaseAmount: 10_000, idempotencyKey: key });

    beforeEach(async () => {
      memberId = (await seedMember(ctx.db, orgId)).memberId;
      auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    });

    it('takes 110% of the limit, then answers 402, warning at 80% and 100% once each', async () => {
      await license({ limits: { transactionsMonthly: 10 } });
      for (let i = 0; i < 11; i += 1) await earn(`earn-${i}`).expect(201);
      const refused = await earn('earn-11').expect(402);
      expect(refused.body).toMatchObject({
        statusCode: 402,
        code: 'LICENSE_LIMIT_REACHED',
        limit: 'transactionsMonthly',
        used: 11,
        allowed: 11,
      });
      expect(await ctx.db.select().from(schema.loyaltyTransactions)).toHaveLength(11);
      expect((await usageRow()).transactions).toBe(11);
      expect(await thresholdEvents()).toEqual([80, 100]);

      // The license read counts the same.
      const read = await ctx.http().get(`/v1/console/organizations/${orgId}/license`).set(bearer('owner')).expect(200);
      expect(read.body.usage.transactionsMonthly).toBe(11);
    });

    it('never lets concurrent earns past the limit', async () => {
      await license({ limits: { transactionsMonthly: 10 } });
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => earn(`race-${i}`)));
      expect(results.filter((res) => res.status === 201)).toHaveLength(11);
      expect(results.filter((res) => res.status === 402)).toHaveLength(19);
      expect((await usageRow()).transactions).toBe(11);
      expect(await ctx.db.select().from(schema.loyaltyTransactions)).toHaveLength(11);
    });

    it('gives back the count of an earn that fails, once', async () => {
      await license({ limits: { transactionsMonthly: 10 } });
      const accepted = [];
      for (let i = 0; i < 11; i += 1) accepted.push((await earn(`earn-${i}`).expect(201)).body.transactionId);
      await earn('earn-full').expect(402);
      const credits = new CreditsRepository(ctx.db);
      const failure = {
        loyaltyTransactionId: accepted[0],
        organizationEndUserId: memberId,
        failureCode: 'BUDGET_EXHAUSTED' as const,
      };
      await credits.failEarnOnChain(failure);
      await credits.failEarnOnChain(failure);
      expect((await usageRow()).transactions).toBe(10);
      await earn('earn-after-failure').expect(201);
      await earn('earn-full-again').expect(402);
    });

    it('lets a retry under the same key through without counting it twice', async () => {
      await license({ limits: { transactionsMonthly: 10 } });
      await earn('same').expect(201);
      await earn('same').expect(201);
      expect((await usageRow()).transactions).toBe(1);
    });

    it('enforces nothing for an organization without a license', async () => {
      for (let i = 0; i < 3; i += 1) await earn(`free-${i}`).expect(201);
      expect(await ctx.db.select().from(schema.licenseUsage)).toEqual([]);
    });
  });

  describe('resources', () => {
    it('caps active API keys at the license, before the platform cap', async () => {
      await license({ limits: { apiKeys: 2 } });
      const create = () =>
        ctx
          .http()
          .post(`/v1/console/organizations/${orgId}/api-credentials`)
          .set(bearer('owner'))
          .send({ name: 'server', scope: 'read' });
      await create().expect(201);
      await create().expect(201);
      const refused = await create().expect(402);
      expect(refused.body).toMatchObject({ code: 'LICENSE_LIMIT_REACHED', limit: 'apiKeys', used: 2, allowed: 2 });
    });

    it('caps the team when inviting, accepting and restoring', async () => {
      await license({ limits: { teamMembers: 3 } });
      const invite = (email: string) =>
        ctx.http().post(`/v1/console/organizations/${orgId}/invitations`).set(bearer('owner')).send({ email });
      // Two of three places taken: an invitation goes out.
      const pending = (await invite('newdev@example.com').expect(201)).body.token as string;
      // A third member joins meanwhile: the team is full.
      const [third] = await ctx.db
        .insert(schema.systemUsers)
        .values({ email: 'third@example.com', fullName: 'Third' })
        .returning();
      await ctx.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: orgId, systemUserId: third.id, role: 'BUSINESS_DEVELOPER' });
      expect((await invite('later@example.com').expect(402)).body).toMatchObject({
        code: 'LICENSE_LIMIT_REACHED',
        limit: 'teamMembers',
      });
      await ctx.http().post(`/v1/console/invitations/${pending}/accept`).set(bearer('newdev')).send({}).expect(402);

      // Suspending one frees a place; restoring takes it back only while one is free.
      const access = (target: string, status: string) =>
        ctx.http().patch(`/v1/console/organizations/${orgId}/staff/${target}`).set(bearer('owner')).send({ status });
      await access(third.id, 'SUSPENDED').expect(200);
      await ctx.http().post(`/v1/console/invitations/${pending}/accept`).set(bearer('newdev')).send({}).expect(201);
      await access(third.id, 'ACTIVE').expect(402);
    });

    it('caps new members, counting only active ones, and never refuses one already enrolled', async () => {
      await license({ limits: { members: 1 } });
      // A blocked customer doesn't take the place.
      const blocked = await seedMember(ctx.db, orgId);
      await ctx.db.update(schema.endUsers).set({ status: 'BLOCKED' }).where(eq(schema.endUsers.id, blocked.endUser.id));
      const first = await seedMember(ctx.db, orgId);
      const [another] = await ctx.db.insert(schema.endUsers).values({}).returning();
      const identity = ctx.app.get(IdentityRepository);
      await expect(identity.enroll({ organizationId: orgId, endUserId: another.id })).rejects.toMatchObject({
        status: 402,
      });
      await expect(identity.enroll({ organizationId: orgId, endUserId: first.endUser.id })).resolves.toBeUndefined();
    });
  });

  describe('features', () => {
    it('answers 402 for each feature the license lacks, and 403 first to an outsider', async () => {
      await license({ features: [] });
      const webhook = (actor: string) =>
        ctx
          .http()
          .post(`/v1/console/organizations/${orgId}/webhooks/endpoints`)
          .set(bearer(actor))
          .send({ url: 'https://merchant.test/hooks' });
      expect((await webhook('owner').expect(402)).body).toMatchObject({
        code: 'LICENSE_FEATURE_NOT_INCLUDED',
        feature: 'webhooks',
      });
      await webhook('outsider').expect(403);

      await ctx
        .http()
        .post(`/v1/console/organizations/${orgId}/voucher-batches`)
        .set(bearer('owner'))
        .send({ items: [] })
        .expect(402);
      const { rawKey } = await seedCredential(ctx.db, orgId);
      await ctx
        .http()
        .post('/v1/rewards/voucher-batches')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({ items: [] })
        .expect(402);
      await ctx
        .http()
        .post(`/v1/console/organizations/${orgId}/assistant/messages`)
        .set(bearer('owner'))
        .send({ messages: [] })
        .expect(402);
    });

    it('lets the Owner turn approval on only with the feature, and off whatever the license', async () => {
      await license({ features: ['webhooks'] });
      const settings = (voucherApprovalRequired: boolean) =>
        ctx
          .http()
          .patch(`/v1/console/organizations/${orgId}/settings`)
          .set(bearer('owner'))
          .send({ voucherApprovalRequired });
      expect((await settings(true).expect(402)).body).toMatchObject({ feature: 'voucher.approval' });
      await settings(false).expect(200);
      const [org] = await ctx.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
      expect(org.voucherApprovalRequired).toBe(false);
    });

    it('refuses sandbox keys without the sandbox', async () => {
      await license({ features: ['webhooks'] });
      const { rawKey } = await seedCredential(ctx.db, orgId, { environment: 'SANDBOX', scopes: ['read'] });
      const res = await ctx.http().get('/v1/license').set('Authorization', `Bearer ${rawKey}`).expect(402);
      expect(res.body).toMatchObject({ feature: 'sandbox' });
    });

    it("stops the assistant's token when the license loses the assistant", async () => {
      await license({ features: ALL.filter((feature) => feature !== 'assistant') });
      const token = await ctx.app.get(McpOAuthService).issueAssistantToken({
        userId: ids.owner,
        organizationId: orgId,
        persona: 'BUSINESS_OWNER',
        resource: 'http://localhost/mcp',
      });
      const res = await ctx
        .http()
        .get(`/v1/console/organizations/${orgId}/license`)
        .set('Authorization', `Bearer ${token}`)
        .expect(402);
      expect(res.body).toMatchObject({ feature: 'assistant' });
    });
  });
});
