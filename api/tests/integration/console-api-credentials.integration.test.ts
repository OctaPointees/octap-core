import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedCredential, seedOrganization } from './support/db.js';
import { hashApiKey } from '#infra/auth/api-key-hash.util.js';
import {
  API_CREDENTIAL_LIMIT_REACHED,
  ApiCredentialsService,
  MAX_ACTIVE_API_CREDENTIALS,
} from '#infra/auth/api-credentials.service.js';

const ACTORS = ['owner', 'developer', 'stranger', 'inactive', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

describe('console API keys: issue, rename and revoke from a Google session', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
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
  const path = (org = orgId) => `/v1/console/organizations/${org}/api-credentials`;
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const issue = (actor: Actor, body: Record<string, unknown> = { name: 'pos' }, org = orgId) =>
    ctx.http().post(path(org)).set(as(actor)).send(body);
  const list = async (actor: Actor = 'owner') =>
    (await ctx.http().get(path()).set(as(actor)).expect(200)).body as Record<string, unknown>[];
  const withKey = (rawKey: string) => ({ authorization: `Bearer ${rawKey}` });
  const credentialRow = async (id: string) =>
    (await ctx.db.select().from(schema.apiCredentials).where(eq(schema.apiCredentials.id, id)))[0];

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
      { organizationId: orgId, systemUserId: ids.inactive, role: 'BUSINESS_DEVELOPER', status: 'INACTIVE' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
  });

  it('lets the Owner and a Business Developer issue a key that calls the real API', async () => {
    for (const actor of ['owner', 'developer'] as const) {
      const res = await issue(actor, { name: `${actor} till` }).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      // No scope sent: a read key.
      expect(res.body).toMatchObject({ name: `${actor} till`, scopes: ['read'], status: 'ACTIVE' });
      await ctx.http().get('/v1/rewards/vouchers').set(withKey(res.body.rawKey)).expect(200);
    }
  });

  it('lets only the Owner create a write key, and a Business Developer manage read keys only', async () => {
    await issue('developer', { name: 'bd write', scope: 'write' }).expect(403);
    const write = (await issue('owner', { name: 'owner write', scope: 'write' }).expect(201)).body as { id: string };
    const read = (await issue('owner', { name: 'owner read' }).expect(201)).body as { id: string };

    await ctx.http().delete(`${path()}/${write.id}`).set(as('developer')).expect(403);
    await ctx.http().patch(`${path()}/${write.id}`).set(as('developer')).send({ name: 'x' }).expect(403);
    expect(await credentialRow(write.id)).toMatchObject({ status: 'ACTIVE', name: 'owner write' });
    // A script-issued admin key is more than read access too.
    const admin = await seedCredential(ctx.db, orgId, { scopes: ['read', 'write', 'admin'] });
    await ctx.http().delete(`${path()}/${admin.credential.id}`).set(as('developer')).expect(403);

    await ctx.http().patch(`${path()}/${read.id}`).set(as('developer')).send({ name: 'renamed' }).expect(200);
    await ctx.http().delete(`${path()}/${read.id}`).set(as('developer')).expect(200);
    await ctx.http().delete(`${path()}/${write.id}`).set(as('owner')).expect(200);
    await ctx.http().delete(`${path()}/${admin.credential.id}`).set(as('owner')).expect(200);
  });

  it('shows the raw key only in the create response, and stores only its hash and prefix', async () => {
    const res = await issue('owner').expect(201);
    const { rawKey, id } = res.body as { rawKey: string; id: string };
    expect(res.body).not.toHaveProperty('keyHash');
    const row = await credentialRow(id);
    expect(row.keyHash).toBe(hashApiKey(rawKey));
    expect(rawKey.startsWith(row.keyPrefix)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(rawKey);

    const listed = await list('developer');
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(
      ['createdAt', 'id', 'keyPrefix', 'lastUsedAt', 'name', 'scopes', 'status'].sort(),
    );
    expect(listed[0].lastUsedAt).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(rawKey);
  });

  it('reports when a key was last used', async () => {
    const { rawKey } = (await issue('owner').expect(201)).body as { rawKey: string };
    await ctx.http().get('/v1/rewards/vouchers').set(withKey(rawKey)).expect(200);
    // The guard records use after the request, without waiting for the write.
    let lastUsedAt: unknown = null;
    for (let i = 0; i < 20 && !lastUsedAt; i += 1) {
      lastUsedAt = (await list())[0].lastUsedAt;
      if (!lastUsedAt) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(typeof lastUsedAt).toBe('string');
  });

  it('revokes a key: 401 from the next request, gone from the list, row kept as REVOKED', async () => {
    const { rawKey, id } = (await issue('developer').expect(201)).body as { rawKey: string; id: string };
    const res = await ctx.http().delete(`${path()}/${id}`).set(as('developer')).expect(200);
    expect(res.body).toEqual({ revoked: true });
    await ctx.http().get('/v1/rewards/vouchers').set(withKey(rawKey)).expect(401);
    expect(await list()).toEqual([]);
    expect((await credentialRow(id)).status).toBe('REVOKED');
    // Revoking again is harmless.
    await ctx.http().delete(`${path()}/${id}`).set(as('owner')).expect(200);
  });

  it('gives a read key the read routes only, and a write key both', async () => {
    const read = (await issue('owner', { name: 'reader', scope: 'read' }).expect(201)).body;
    const write = (await issue('owner', { name: 'writer', scope: 'write' }).expect(201)).body;
    expect(read.scopes).toEqual(['read']);
    expect(write.scopes).toEqual(['read', 'write']);

    await ctx.http().get('/v1/rewards/vouchers').set(withKey(read.rawKey)).expect(200);
    await ctx.http().post('/v1/rewards/vouchers').set(withKey(read.rawKey)).send({}).expect(403);
    await ctx.http().get('/v1/rewards/vouchers').set(withKey(write.rawKey)).expect(200);
    // Past the scope check: the empty body is what is refused.
    await ctx.http().post('/v1/rewards/vouchers').set(withKey(write.rawKey)).send({}).expect(400);
  });

  it('refuses admin, an unknown scope, extra fields and a bad name with 400', async () => {
    for (const body of [
      { name: 'pos', scope: 'admin' },
      { name: 'pos', scope: 'owner' },
      { name: 'pos', scopes: ['admin'] },
      { name: ' ' },
      { name: 'x'.repeat(101) },
    ]) {
      await issue('owner', body).expect(400);
    }
    expect(await list()).toEqual([]);
  });

  it('refuses outsiders, inactive members, other roles and other organizations with 403', async () => {
    const { id } = (await issue('owner').expect(201)).body as { id: string };
    for (const actor of ['stranger', 'inactive', 'outsider'] as const) {
      await issue(actor).expect(403);
      await ctx.http().get(path()).set(as(actor)).expect(403);
      await ctx.http().delete(`${path()}/${id}`).set(as(actor)).expect(403);
      await ctx.http().patch(`${path()}/${id}`).set(as(actor)).send({ name: 'stolen' }).expect(403);
    }
    await ctx.http().post(path()).send({ name: 'pos' }).expect(401);
    expect((await credentialRow(id)).status).toBe('ACTIVE');
  });

  it('issues no key for an organization that is not ACTIVE', async () => {
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await issue('owner').expect(403);
    expect(await ctx.db.select().from(schema.apiCredentials)).toEqual([]);
  });

  it('cannot revoke or rename another organization’s key through this organization’s path', async () => {
    const foreign = await seedCredential(ctx.db, otherOrgId);
    await ctx.http().delete(`${path()}/${foreign.credential.id}`).set(as('owner')).expect(404);
    await ctx.http().patch(`${path()}/${foreign.credential.id}`).set(as('owner')).send({ name: 'x' }).expect(404);
    expect(await credentialRow(foreign.credential.id)).toMatchObject({ status: 'ACTIVE', name: 'test' });
    await ctx.http().delete(`${path()}/not-a-uuid`).set(as('owner')).expect(400);
  });

  it('renames an ACTIVE key, but not a revoked one', async () => {
    const { id } = (await issue('owner').expect(201)).body as { id: string };
    const res = await ctx.http().patch(`${path()}/${id}`).set(as('developer')).send({ name: ' Till 2 ' }).expect(200);
    expect(res.body).toMatchObject({ id, name: 'Till 2' });
    expect(res.body).not.toHaveProperty('rawKey');
    await ctx.http().patch(`${path()}/${id}`).set(as('owner')).send({ name: 'x', scope: 'read' }).expect(400);
    await ctx.http().delete(`${path()}/${id}`).set(as('owner')).expect(200);
    await ctx.http().patch(`${path()}/${id}`).set(as('owner')).send({ name: 'again' }).expect(404);
  });

  it(`holds an organization to ${MAX_ACTIVE_API_CREDENTIALS} ACTIVE keys, even under concurrent requests`, async () => {
    // Script-issued and revoked keys: the first count, the second do not.
    for (let i = 0; i < MAX_ACTIVE_API_CREDENTIALS - 2; i += 1) await seedCredential(ctx.db, orgId);
    await seedCredential(ctx.db, orgId, { status: 'REVOKED' });
    const kept = (await issue('owner').expect(201)).body as { id: string };

    // One slot left: two requests at once must not both take it.
    const statuses = (await Promise.all([issue('owner'), issue('developer')])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const refused = await issue('owner').expect(409);
    expect(refused.body).toMatchObject({ statusCode: 409, code: API_CREDENTIAL_LIMIT_REACHED });
    const active = await ctx.db.select().from(schema.apiCredentials).where(eq(schema.apiCredentials.status, 'ACTIVE'));
    expect(active.filter((c) => c.organizationId === orgId)).toHaveLength(MAX_ACTIVE_API_CREDENTIALS);

    // Another organization has its own limit; revoking one frees a slot.
    await issue('outsider', { name: 'pos' }, otherOrgId).expect(201);
    await ctx.http().delete(`${path()}/${kept.id}`).set(as('owner')).expect(200);
    await issue('owner').expect(201);
  });

  it('no longer serves /v1/api-credentials, while the seed script path still issues keys', async () => {
    const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read', 'write', 'admin'] });
    await ctx.http().get('/v1/api-credentials').set(withKey(rawKey)).expect(404);
    await ctx.http().post('/v1/api-credentials').set(withKey(rawKey)).send({ name: 'x' }).expect(404);

    // scripts/seed-dev-credential.mjs calls the service directly, with no transaction of its own.
    const seeded = await ctx.app.get(ApiCredentialsService).issue(orgId, 'seed', ['read', 'write', 'admin']);
    await ctx.http().get('/v1/rewards/vouchers').set(withKey(seeded.rawKey)).expect(200);
    expect((await list()).map((c) => c.name)).toEqual(expect.arrayContaining(['seed']));
  });
});
