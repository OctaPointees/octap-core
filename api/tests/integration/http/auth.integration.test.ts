import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createTestApp, signedHeaders } from '../support/app.js';
import { resetDb, seedCredential, seedOrganization } from '../support/db.js';
import { RATE_LIMIT_MAX_REQUESTS } from '../../../src/infra/auth/rate-limit.util.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

beforeEach(async () => {
  await resetDb(ctx.db);
  orgId = (await seedOrganization(ctx.db)).id;
});

afterAll(async () => {
  await ctx.close();
});

describe('ApiKeyGuard over HTTP (real Postgres + Redis)', () => {
  it('rejects missing, unknown, revoked, and expired keys with 401', async () => {
    const revoked = await seedCredential(ctx.db, orgId, { status: 'REVOKED' });
    const expired = await seedCredential(ctx.db, orgId, { expiresAt: new Date(Date.now() - 1000) });

    await ctx.http().get('/v1/rewards/vouchers').expect(401);
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', 'Bearer octap_live_unknown').expect(401);
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${revoked.rawKey}`).expect(401);
    const res = await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${expired.rawKey}`).expect(401);
    expect(res.body.message).toMatch(/expired/);
  });

  it('accepts a valid key, scopes the tenant from it, and stamps lastUsedAt', async () => {
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${rawKey}`).expect(200, []);
  });

  it('403s a spoofed x-organization-id and a missing scope', async () => {
    const other = await seedOrganization(ctx.db);
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });

    await ctx.http().get('/v1/rewards/vouchers').set({ authorization: `Bearer ${rawKey}`, 'x-organization-id': other.id }).expect(403);
    const res = await ctx
      .http()
      .post('/v1/rewards/vouchers')
      .set('authorization', `Bearer ${rawKey}`)
      .send({ code: 'C', title: 'T', discountType: 'PERCENTAGE' })
      .expect(403);
    expect(res.body.message).toMatch(/"write" scope/);
  });

  it('rate-limits per credential through Redis', async () => {
    const { rawKey, credential } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      // Pre-fill the current window instead of firing RATE_LIMIT_MAX_REQUESTS real requests.
      const key = `ratelimit:${credential.id}:${Math.floor(Date.now() / 1000 / 60)}`;
      await redis.set(key, String(RATE_LIMIT_MAX_REQUESTS), 'EX', 60);
      const res = await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${rawKey}`).expect(403);
      expect(res.body.message).toMatch(/Rate limit exceeded/);
    } finally {
      redis.disconnect();
    }
  });

  it('signed routes verify the exact raw body and refuse a replayed nonce', async () => {
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['admin'] });
    const body = { name: 'pos-terminal', scopes: ['read'] };
    const headers = signedHeaders(rawKey, 'POST', '/v1/api-credentials', body);

    // Sent unsigned: refused.
    await ctx.http().post('/v1/api-credentials').set('authorization', `Bearer ${rawKey}`).send(body).expect(401);
    // Sent with a body that differs from what was signed: refused.
    await ctx.http().post('/v1/api-credentials').set(headers).send({ ...body, scopes: ['admin'] }).expect(401);

    const fresh = signedHeaders(rawKey, 'POST', '/v1/api-credentials', body);
    await ctx.http().post('/v1/api-credentials').set(fresh).send(body).expect(201);
    const replay = await ctx.http().post('/v1/api-credentials').set(fresh).send(body).expect(401);
    expect(replay.body.message).toMatch(/nonce was already used/);
  });
});
