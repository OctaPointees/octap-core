import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_RATE_LIMIT_MAX_REQUESTS } from '#infra/auth/public-rate-limit.guard.js';
import { EnokiTokenRejectedError } from '#infra/clients/enoki/enoki.client.js';
import { createTestApp } from '../support/app.js';
import { resetDb, seedCredential, seedOrganization } from '../support/db.js';

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

/** Called by the customer's own device, which never holds a merchant API key (docs/roadmap.md). */
describe('identity over HTTP (no merchant API key)', () => {
  it('google-login creates the end user once, then enroll is idempotent per organization', async () => {
    const first = await ctx.http().post('/v1/identity/google-login').send({ idToken: 'google-jwt' }).expect(201);
    expect(first.body).toMatchObject({ suiAddress: '0xzklogin', isNewUser: true });
    expect(ctx.adapters.enoki.resolveZkLoginAddress).toHaveBeenCalledWith('google-jwt');

    const again = await ctx.http().post('/v1/identity/google-login').send({ idToken: 'google-jwt' }).expect(201);
    expect(again.body).toMatchObject({ endUserId: first.body.endUserId, isNewUser: false });

    const enrolled = await ctx
      .http()
      .post(`/v1/identity/organizations/${orgId}/enroll`)
      .send({ idToken: 'google-jwt', externalMemberId: 'loyalty-card-7' })
      .expect(201);
    expect(enrolled.body.isNewEnrollment).toBe(true);
    const reenrolled = await ctx
      .http()
      .post(`/v1/identity/organizations/${orgId}/enroll`)
      .send({ idToken: 'google-jwt' })
      .expect(201);
    expect(reenrolled.body).toEqual({
      organizationEndUserId: enrolled.body.organizationEndUserId,
      endUserId: first.body.endUserId,
      isNewEnrollment: false,
    });
  });

  it('enrolls a customer whose first request is enroll, once under concurrent requests', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ idToken: 'google-jwt' }).expect(201),
      ),
    );
    const members = new Set(results.map((res) => res.body.organizationEndUserId));
    expect(members.size).toBe(1);
    expect(results.filter((res) => res.body.isNewEnrollment)).toHaveLength(1);
  });

  it('a bare endUserId no longer enrolls anyone', async () => {
    const { body: user } = await ctx.http().post('/v1/identity/google-login').send({ idToken: 'google-jwt' });
    ctx.adapters.enoki.resolveZkLoginAddress.mockClear();

    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ endUserId: user.endUserId }).expect(400);

    expect(ctx.adapters.enoki.resolveZkLoginAddress).not.toHaveBeenCalled();
  });

  it('answers 401, not 5xx, for a token Enoki rejects, and 500 for anything else', async () => {
    ctx.adapters.enoki.resolveZkLoginAddress.mockRejectedValueOnce(new EnokiTokenRejectedError('jwt_error'));
    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ idToken: 'expired' }).expect(401);

    ctx.adapters.enoki.resolveZkLoginAddress.mockRejectedValueOnce(new EnokiTokenRejectedError('jwt_error'));
    await ctx.http().post('/v1/identity/google-login').send({ idToken: 'expired' }).expect(401);

    ctx.adapters.enoki.resolveZkLoginAddress.mockRejectedValueOnce(new Error('Enoki is down'));
    await ctx.http().post('/v1/identity/google-login').send({ idToken: 'valid' }).expect(500);
  });

  it('answers 404 for a missing organization and 400 for a malformed id', async () => {
    await ctx
      .http()
      .post('/v1/identity/organizations/00000000-0000-0000-0000-000000000000/enroll')
      .send({ idToken: 'google-jwt' })
      .expect(404);
    await ctx.http().post('/v1/identity/organizations/not-a-uuid/enroll').send({ idToken: 'google-jwt' }).expect(400);
  });

  it('proxies zkLogin nonce and proof to Enoki', async () => {
    const nonce = await ctx.http().post('/v1/identity/zklogin/nonce').send({ ephemeralPublicKey: 'epk' }).expect(201);
    expect(nonce.body).toMatchObject({ nonce: 'nonce', maxEpoch: 3 });

    await ctx
      .http()
      .post('/v1/identity/zklogin/proof')
      .send({ idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 3 })
      .expect(201);
    expect(ctx.adapters.enoki.createZkLoginProof).toHaveBeenCalledWith(
      expect.objectContaining({ jwt: 'jwt', maxEpoch: 3 }),
    );
  });

  it('validates bodies', async () => {
    await ctx.http().post('/v1/identity/google-login').send({}).expect(400);
    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({}).expect(400);
    await ctx.http().post('/v1/identity/zklogin/nonce').send({}).expect(400);
    await ctx.http().post('/v1/identity/zklogin/proof').send({ idToken: 'jwt' }).expect(400);
  });
});

describe('POST /v1/identity/verify (merchant API key)', () => {
  const verify = (rawKey: string, idToken: unknown = 'google-jwt') =>
    ctx.http().post('/v1/identity/verify').set('authorization', `Bearer ${rawKey}`).send({ idToken });

  it('returns the same member as the browser flow, null before enrollment, and writes nothing', async () => {
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });

    const unknown = await verify(rawKey).expect(200);
    expect(unknown.body).toEqual({ endUserId: null, suiAddress: '0xzklogin', memberId: null });
    const login = await ctx.http().post('/v1/identity/google-login').send({ idToken: 'google-jwt' }).expect(201);
    expect(login.body.isNewUser).toBe(true);

    const notEnrolled = await verify(rawKey).expect(200);
    expect(notEnrolled.body).toEqual({ endUserId: login.body.endUserId, suiAddress: '0xzklogin', memberId: null });
    const first = await ctx
      .http()
      .post(`/v1/identity/organizations/${orgId}/enroll`)
      .send({ idToken: 'google-jwt' })
      .expect(201);
    expect(first.body.isNewEnrollment).toBe(true);

    const enrolled = await verify(rawKey).expect(200);
    expect(enrolled.body.memberId).toBe(first.body.organizationEndUserId);
    expect(enrolled.headers['cache-control']).toBe('no-store');
  });

  it('never reports membership in another organization', async () => {
    const other = await seedOrganization(ctx.db);
    const { rawKey } = await seedCredential(ctx.db, other.id, { scopes: ['read'] });
    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ idToken: 'google-jwt' }).expect(201);

    expect((await verify(rawKey).expect(200)).body.memberId).toBeNull();
  });

  it('requires a credential with the read scope, and a valid token', async () => {
    await ctx.http().post('/v1/identity/verify').send({ idToken: 'google-jwt' }).expect(401);
    const { rawKey: writeOnly } = await seedCredential(ctx.db, orgId, { scopes: ['write'] });
    await verify(writeOnly).expect(403);

    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
    await verify(rawKey, 42).expect(400);
    ctx.adapters.enoki.resolveZkLoginAddress.mockRejectedValueOnce(new EnokiTokenRejectedError('jwt_error'));
    await verify(rawKey, 'expired').expect(401);
  });
});

describe('public route rate limit', () => {
  const windowBucket = () => Math.floor(Date.now() / 1000 / 60);
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  // Exhausted windows would otherwise reject every later public request in this run.
  afterEach(async () => {
    const keys = await redis.keys('ratelimit:public-ip:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(() => {
    redis.disconnect();
  });

  /** Pre-fills every address the local test client can appear as, instead of firing real requests. */
  const exhaust = async (...addresses: string[]) => {
    for (const address of addresses) {
      await redis.set(
        `ratelimit:public-ip:${address}:${windowBucket()}`,
        String(PUBLIC_RATE_LIMIT_MAX_REQUESTS),
        'EX',
        60,
      );
    }
  };
  const localAddresses = ['127.0.0.1', '0:0:0:0::/64'];

  it.each([
    ['google-login', '/v1/identity/google-login', { idToken: 'jwt' }],
    ['nonce', '/v1/identity/zklogin/nonce', { ephemeralPublicKey: 'epk' }],
    [
      'proof',
      '/v1/identity/zklogin/proof',
      { idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 3 },
    ],
    ['finalize', '/v1/credits/redeem/finalize', { digest: 'd', signature: 's' }],
  ])('%s answers 429 past the limit without calling Enoki', async (_name, path, body) => {
    await exhaust(...localAddresses);
    const enoki = Object.values(ctx.adapters.enoki);
    enoki.forEach((fn) => fn.mockClear());

    const res = await ctx.http().post(path).send(body).expect(429);

    expect(res.body.message).toMatch(/Too many requests/);
    enoki.forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('enroll answers 429 past the limit without calling Enoki', async () => {
    await exhaust(...localAddresses);
    ctx.adapters.enoki.resolveZkLoginAddress.mockClear();

    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ idToken: 'jwt' }).expect(429);

    expect(ctx.adapters.enoki.resolveZkLoginAddress).not.toHaveBeenCalled();
  });

  it('ignores X-Forwarded-For by default, so a client cannot forge a new address', async () => {
    await exhaust(...localAddresses);
    await ctx
      .http()
      .post('/v1/identity/google-login')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ idToken: 'jwt' })
      .expect(429);
  });

  it('counts the forwarded client behind a trusted proxy', async () => {
    const express = ctx.app.getHttpAdapter().getInstance();
    express.set('trust proxy', 1);
    try {
      await exhaust('203.0.113.9');
      const send = (ip: string) =>
        ctx.http().post('/v1/identity/google-login').set('x-forwarded-for', ip).send({ idToken: 'jwt' });
      await send('203.0.113.9').expect(429);
      await send('203.0.113.10').expect(201);
    } finally {
      express.set('trust proxy', false);
    }
  });

  it('does not touch credentialed routes', async () => {
    await exhaust(...localAddresses);
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
    await ctx
      .http()
      .post('/v1/identity/verify')
      .set('authorization', `Bearer ${rawKey}`)
      .send({ idToken: 'jwt' })
      .expect(200);
  });
});
