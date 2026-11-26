import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from '../support/app.js';
import { resetDb, schema, seedCredential, seedOrganization } from '../support/db.js';
import { RequestLogsRepository } from '#infra/db/repositories/request-logs.repository.js';

const ACTORS = ['owner', 'developer', 'stranger', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

describe('request log: every API-key call, readable by the organization’s developers', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let otherOrgId: string;
  let readKey: { credential: { id: string }; rawKey: string };
  let otherOrgKey: { credential: { id: string }; rawKey: string };
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
  const withKey = (rawKey: string) => ({ authorization: `Bearer ${rawKey}`, 'user-agent': 'integration-test/1.0' });
  const logs = (actor: Actor, suffix = '', query: Record<string, string> = {}, org = orgId) =>
    ctx.http().get(`/v1/console/organizations/${org}/request-logs${suffix}`).query(query).set(as(actor));
  const logged = async (organizationId: string) =>
    ctx.db.select().from(schema.apiRequestLogs).where(eq(schema.apiRequestLogs.organizationId, organizationId));
  const waitForRows = (organizationId: string, n: number) =>
    vi.waitFor(async () => expect(await logged(organizationId)).toHaveLength(n), { timeout: 5000, interval: 50 });

  /** Three calls with one read key: a 200, a 404 and a 403 (missing scope). Returns their request ids. */
  async function makeCalls() {
    const ok = await ctx.http().get('/v1/rewards/vouchers').set(withKey(readKey.rawKey)).expect(200);
    const missing = await ctx.http().get(`/v1/credits/members/${randomUUID()}/balance`).set(withKey(readKey.rawKey));
    const forbidden = await ctx
      .http()
      .post('/v1/credits/earn')
      .set(withKey(readKey.rawKey))
      .send({ organizationEndUserId: randomUUID(), purchaseAmount: 1000, idempotencyKey: 'k1' })
      .expect(403);
    await waitForRows(orgId, 3);
    return {
      ok: ok.headers['x-request-id'] as string,
      missing: missing.headers['x-request-id'] as string,
      missingStatus: missing.status,
      forbidden: forbidden.headers['x-request-id'] as string,
    };
  }

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    const ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    readKey = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
    otherOrgKey = await seedCredential(ctx.db, otherOrgId, { scopes: ['read'] });
  });

  it('records each API-key call with its route, status, latency, category and request id', async () => {
    const calls = await makeCalls();
    const rows = await logged(orgId);
    const ok = rows.find((row) => row.requestId === calls.ok)!;
    expect(ok).toMatchObject({
      credentialId: readKey.credential.id,
      method: 'GET',
      route: '/v1/rewards/vouchers',
      path: '/v1/rewards/vouchers',
      statusCode: 200,
      category: 'vouchers',
      errorBody: null,
      userAgent: 'integration-test/1.0',
    });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    const missing = rows.find((row) => row.requestId === calls.missing)!;
    expect(missing).toMatchObject({ route: '/v1/credits/members/:memberId/balance', category: 'credits' });
    const forbidden = rows.find((row) => row.requestId === calls.forbidden)!;
    expect(forbidden).toMatchObject({ statusCode: 403, method: 'POST', route: '/v1/credits/earn' });
    expect(forbidden.errorMessage).toContain('write');
    expect(forbidden.errorBody).toMatchObject({ statusCode: 403 });
  });

  it('records nothing for console sessions or unknown keys', async () => {
    await logs('owner').expect(200);
    await ctx.http().get('/v1/rewards/vouchers').set(withKey('octap_nope')).expect(401);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await ctx.db.select().from(schema.apiRequestLogs)).toHaveLength(0);
  });

  it('lists newest first, filters and pages', async () => {
    const calls = await makeCalls();
    const all = (await logs('owner').expect(200)).body;
    expect(all).toMatchObject({ page: 1, limit: 50, total: 3 });
    expect(all.items.map((item: { requestId: string }) => item.requestId)).toEqual([
      calls.forbidden,
      calls.missing,
      calls.ok,
    ]);
    expect(all.items[0].credential).toEqual({ id: readKey.credential.id, name: 'test', keyPrefix: expect.any(String) });
    expect(all.items[0]).not.toHaveProperty('errorBody');

    expect((await logs('owner', '', { status: 'failed' }).expect(200)).body.total).toBe(2);
    expect((await logs('owner', '', { status: '403' }).expect(200)).body.items[0].requestId).toBe(calls.forbidden);
    expect((await logs('owner', '', { status: 'succeeded' }).expect(200)).body.total).toBe(1);
    expect((await logs('owner', '', { category: 'credits' }).expect(200)).body.total).toBe(2);
    expect((await logs('owner', '', { method: 'post' }).expect(200)).body.total).toBe(1);
    expect((await logs('owner', '', { route: '/v1/rewards/vouchers' }).expect(200)).body.total).toBe(1);
    expect((await logs('owner', '', { credentialId: randomUUID() }).expect(200)).body.total).toBe(0);
    const page2 = (await logs('owner', '', { limit: '2', page: '2' }).expect(200)).body;
    expect(page2).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page2.items.map((item: { requestId: string }) => item.requestId)).toEqual([calls.ok]);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (await logs('owner', '', { from: future, to: new Date(Date.now() + 7_200_000).toISOString() }).expect(200)).body
        .total,
    ).toBe(0);
    await logs('owner', '', { status: 'teapot' }).expect(400);
  });

  it('returns one call by its X-Request-Id, with a failed call’s full error body', async () => {
    const calls = await makeCalls();
    const detail = (await logs('developer', `/${calls.forbidden}`).expect(200)).body;
    expect(detail).toMatchObject({ requestId: calls.forbidden, statusCode: 403, errorBody: { statusCode: 403 } });
    expect((await logs('owner', `/${calls.ok}`).expect(200)).body.errorBody).toBeNull();
    await logs('owner', `/${randomUUID()}`).expect(404);
  });

  it('lets the Owner and a Business Developer read, nobody else, and never another organization’s calls', async () => {
    const calls = await makeCalls();
    await ctx.http().get('/v1/rewards/vouchers').set(withKey(otherOrgKey.rawKey)).expect(200);
    await waitForRows(otherOrgId, 1);

    await logs('developer').expect(200);
    await logs('stranger').expect(403);
    await logs('outsider').expect(403);
    await logs('outsider', `/${calls.ok}`).expect(403);
    // The other organization's Owner sees their own call only, and not ours by id.
    const theirs = (await logs('outsider', '', {}, otherOrgId).expect(200)).body;
    expect(theirs.total).toBe(1);
    await logs('outsider', `/${calls.ok}`, {}, otherOrgId).expect(404);
  });

  it('summarizes rate, errors and latency, per category, endpoint and key', async () => {
    await makeCalls();
    const summary = (await logs('owner', '/summary').expect(200)).body;
    expect(summary.totals).toMatchObject({ requests: 3, succeeded: 1, clientErrors: 2, serverErrors: 0 });
    expect(summary.totals.errorRate).toBeCloseTo(2 / 3);
    expect(summary.totals.latencyMs.p95).toEqual(expect.any(Number));
    expect(summary.byCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'credits', requests: 2 }),
        expect.objectContaining({ category: 'vouchers', requests: 1 }),
      ]),
    );
    expect(summary.byRoute).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', route: '/v1/credits/earn', requests: 1, errorRate: 1 }),
      ]),
    );
    expect(summary.byCredential).toEqual([
      expect.objectContaining({ credential: expect.objectContaining({ id: readKey.credential.id }), requests: 3 }),
    ]);
  });

  it('draws a time series with every bucket, empty ones included', async () => {
    await makeCalls();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const series = (await logs('owner', '/timeseries', { from, to, interval: '5m' }).expect(200)).body;
    expect(series).toMatchObject({ from, interval: '5m' });
    expect(series.buckets.length).toBe(13);
    expect(series.buckets[0].start).toBe(from);
    const total = series.buckets.reduce((sum: number, bucket: { requests: number }) => sum + bucket.requests, 0);
    expect(total).toBe(3);
    expect(series.buckets.some((bucket: { requests: number }) => bucket.requests === 0)).toBe(true);
  });

  it('groups failed calls by endpoint, status and error code', async () => {
    const calls = await makeCalls();
    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(withKey(readKey.rawKey))
      .send({ organizationEndUserId: randomUUID(), purchaseAmount: 1000, idempotencyKey: 'k2' })
      .expect(403);
    await waitForRows(orgId, 4);
    const groups = (await logs('owner', '/errors').expect(200)).body;
    expect(groups[0]).toMatchObject({ method: 'POST', route: '/v1/credits/earn', statusCode: 403, count: 2 });
    expect(groups[0].lastRequestId).not.toBe(calls.forbidden);
    expect(
      groups.find((group: { route: string }) => group.route === '/v1/credits/members/:memberId/balance'),
    ).toMatchObject({
      statusCode: calls.missingStatus,
      count: 1,
    });
  });

  it('tails new calls from a cursor', async () => {
    await makeCalls();
    const start = (await logs('owner', '/tail').expect(200)).body;
    expect(start.items).toEqual([]);
    const next = await ctx.http().get('/v1/rewards/vouchers').set(withKey(readKey.rawKey)).expect(200);
    await waitForRows(orgId, 4);
    const tail = (await logs('owner', '/tail', { cursor: start.cursor }).expect(200)).body;
    expect(tail.items.map((item: { requestId: string }) => item.requestId)).toEqual([next.headers['x-request-id']]);
    const again = (await logs('owner', '/tail', { cursor: tail.cursor }).expect(200)).body;
    expect(again).toEqual({ items: [], cursor: tail.cursor });
  });

  it('the retention sweep deletes only rows past the cutoff, across organizations', async () => {
    await makeCalls();
    const old = new Date(Date.now() - 31 * 86_400_000);
    await ctx.db.insert(schema.apiRequestLogs).values({
      organizationId: otherOrgId,
      credentialId: otherOrgKey.credential.id,
      requestId: randomUUID(),
      method: 'GET',
      route: '/v1/rewards/vouchers',
      path: '/v1/rewards/vouchers',
      statusCode: 200,
      latencyMs: 3,
      category: 'vouchers',
      createdAt: old,
    });
    const repo = ctx.app.get(RequestLogsRepository);
    expect(await repo.deleteExpired(new Date(Date.now() - 30 * 86_400_000), 1000)).toBe(1);
    expect(await logged(otherOrgId)).toHaveLength(0);
    expect(await logged(orgId)).toHaveLength(3);
  });
});
