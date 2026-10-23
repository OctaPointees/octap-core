import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';
import { resetDb, seedOrganization } from '../support/db.js';

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
      .send({ endUserId: first.body.endUserId, externalMemberId: 'loyalty-card-7' })
      .expect(201);
    expect(enrolled.body.isNewEnrollment).toBe(true);
    const reenrolled = await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ endUserId: first.body.endUserId }).expect(201);
    expect(reenrolled.body).toEqual({ organizationEndUserId: enrolled.body.organizationEndUserId, isNewEnrollment: false });
  });

  it('proxies zkLogin nonce and proof to Enoki', async () => {
    const nonce = await ctx.http().post('/v1/identity/zklogin/nonce').send({ ephemeralPublicKey: 'epk' }).expect(201);
    expect(nonce.body).toMatchObject({ nonce: 'nonce', maxEpoch: 3 });

    await ctx.http().post('/v1/identity/zklogin/proof').send({ idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 3 }).expect(201);
    expect(ctx.adapters.enoki.createZkLoginProof).toHaveBeenCalledWith(expect.objectContaining({ jwt: 'jwt', maxEpoch: 3 }));
  });

  it('validates bodies', async () => {
    await ctx.http().post('/v1/identity/google-login').send({}).expect(400);
    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({}).expect(400);
    await ctx.http().post(`/v1/identity/organizations/${orgId}/enroll`).send({ endUserId: '00000000-0000-0000-0000-000000000000' }).expect(400);
    await ctx.http().post('/v1/identity/zklogin/nonce').send({}).expect(400);
    await ctx.http().post('/v1/identity/zklogin/proof').send({ idToken: 'jwt' }).expect(400);
  });
});
