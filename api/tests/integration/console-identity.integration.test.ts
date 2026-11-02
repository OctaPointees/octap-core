import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization } from './support/db.js';

describe('console Google identity', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const verified = {
    subject: 'google-subject',
    email: 'person@example.com',
    fullName: 'Person',
    avatarUrl: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const google = {
    verify: vi.fn(async (credential: string) => {
      if (credential !== 'valid') throw new UnauthorizedException();
      return verified;
    }),
  };
  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
  });
  const login = () => ctx.http().post('/v1/console/auth/google').send({ idToken: 'valid', systemRole: 'SYSTEM_ADMIN' });

  it('requires a verified credential and ignores client-supplied privileges', async () => {
    await ctx.http().post('/v1/console/auth/google').send({}).expect(400);
    await ctx.http().post('/v1/console/auth/google').send({ idToken: 'forged' }).expect(401);
    await ctx.http().get('/v1/console/me').expect(401);
    await ctx.http().get('/v1/console/me').set('Authorization', 'Bearer merchant-api-key').expect(401);
    const result = await login().expect(201);
    expect(result.body.user).toMatchObject({ email: verified.email, systemRole: 'SYSTEM_USER' });
    expect(result.body.user).not.toHaveProperty('passwordHash');
    expect(result.body.user).not.toHaveProperty('googleSubject');
    expect(result.body.organizations).toEqual([]);
    const repeated = await login().expect(201);
    expect(repeated.body.user.id).toBe(result.body.user.id);
    expect(await ctx.db.select().from(schema.systemUsers)).toHaveLength(1);
  });

  it('never automatically links an existing privileged account by email', async () => {
    await ctx.db
      .insert(schema.systemUsers)
      .values({ email: verified.email, fullName: 'Legacy admin', systemRole: 'SYSTEM_ADMIN' });
    await login().expect(409);
    expect((await ctx.db.select().from(schema.systemUsers))[0].googleSubject).toBeNull();
  });

  it('returns only active owner/developer memberships and refreshes database roles', async () => {
    const initial = await login().expect(201);
    const userId = initial.body.user.id as string;
    const owner = await seedOrganization(ctx.db, { name: 'A Owner' });
    const developer = await seedOrganization(ctx.db, { name: 'B Developer' });
    const legacy = await seedOrganization(ctx.db);
    const inactive = await seedOrganization(ctx.db, { status: 'SUSPENDED' });
    const revoked = await seedOrganization(ctx.db);
    await seedOrganization(ctx.db); // Non-member tenant must not be returned.
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: owner.id, systemUserId: userId, role: 'OWNER' },
      { organizationId: developer.id, systemUserId: userId, role: 'BUSINESS_DEVELOPER' },
      { organizationId: legacy.id, systemUserId: userId, role: 'MANAGER' },
      { organizationId: inactive.id, systemUserId: userId, role: 'OWNER' },
      { organizationId: revoked.id, systemUserId: userId, role: 'OWNER', status: 'INACTIVE' },
    ]);
    await ctx.db
      .update(schema.systemUsers)
      .set({ systemRole: 'SYSTEM_ADMIN' })
      .where(eq(schema.systemUsers.id, userId));
    const result = await ctx.http().get('/v1/console/me').set('Authorization', 'Bearer valid').expect(200);
    expect(result.body.user.systemRole).toBe('SYSTEM_ADMIN');
    expect(result.body.organizations).toEqual([
      { organizationId: owner.id, name: owner.name, slug: owner.slug, persona: 'BUSINESS_OWNER' },
      { organizationId: developer.id, name: developer.name, slug: developer.slug, persona: 'BUSINESS_DEVELOPER' },
    ]);
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'INACTIVE' })
      .where(eq(schema.organizationMemberships.systemUserId, userId));
    expect(
      (await ctx.http().get('/v1/console/me').set('Authorization', 'Bearer valid').expect(200)).body.organizations,
    ).toEqual([]);
  });

  it('resolves concurrent first logins to one account', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => login().expect(201)));
    expect(new Set(results.map((result) => result.body.user.id)).size).toBe(1);
    expect(await ctx.db.select().from(schema.systemUsers)).toHaveLength(1);
  });
});
