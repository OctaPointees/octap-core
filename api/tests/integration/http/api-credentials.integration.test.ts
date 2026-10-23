import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signedHeaders } from '../support/app.js';
import { resetDb, seedCredential, seedOrganization } from '../support/db.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;
let adminKey: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

beforeEach(async () => {
  await resetDb(ctx.db);
  orgId = (await seedOrganization(ctx.db)).id;
  adminKey = (await seedCredential(ctx.db, orgId, { scopes: ['read', 'write', 'admin'] })).rawKey;
});

afterAll(async () => {
  await ctx.close();
});

describe('API credential self-service over HTTP', () => {
  it('issue (signed) -> use the new key -> rotate (signed) -> old key dead -> revoke (signed)', async () => {
    const body = { name: 'pos-terminal-1', scopes: ['read'] };
    const issued = await ctx
      .http()
      .post('/v1/api-credentials')
      .set(signedHeaders(adminKey, 'POST', '/v1/api-credentials', body))
      .send(body)
      .expect(201);
    expect(issued.body).toMatchObject({
      name: 'pos-terminal-1',
      scopes: ['read'],
      status: 'ACTIVE',
      rawKey: expect.stringMatching(/^octap_live_/),
    });
    expect(JSON.stringify(issued.body)).not.toContain('"keyHash":"' + issued.body.rawKey);

    const listed = (await ctx.http().get('/v1/api-credentials').set('authorization', `Bearer ${adminKey}`).expect(200))
      .body;
    expect(listed).toHaveLength(2);
    expect(listed.some((c: { rawKey?: string }) => c.rawKey)).toBe(false);

    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${issued.body.rawKey}`).expect(200);

    const rotatePath = `/v1/api-credentials/${issued.body.id}/rotate`;
    const rotated = await ctx
      .http()
      .post(rotatePath)
      .set(signedHeaders(adminKey, 'POST', rotatePath))
      .expect(201);
    expect(rotated.body.rawKey).not.toBe(issued.body.rawKey);
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${issued.body.rawKey}`).expect(401);
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${rotated.body.rawKey}`).expect(200);

    const revokePath = `/v1/api-credentials/${rotated.body.id}`;
    const revoked = await ctx
      .http()
      .delete(revokePath)
      .set(signedHeaders(adminKey, 'DELETE', revokePath))
      .expect(200);
    expect(revoked.body.status).toBe('REVOKED');
    await ctx.http().get('/v1/rewards/vouchers').set('authorization', `Bearer ${rotated.body.rawKey}`).expect(401);
  });

  it('requires the admin scope and refuses another tenant’s credential', async () => {
    const readOnly = (await seedCredential(ctx.db, orgId, { scopes: ['read'] })).rawKey;
    await ctx.http().get('/v1/api-credentials').set('authorization', `Bearer ${readOnly}`).expect(403);

    const other = await seedOrganization(ctx.db);
    const foreign = await seedCredential(ctx.db, other.id);
    const path = `/v1/api-credentials/${foreign.credential.id}`;
    await ctx
      .http()
      .delete(path)
      .set(signedHeaders(adminKey, 'DELETE', path))
      .expect(404);
  });
});
