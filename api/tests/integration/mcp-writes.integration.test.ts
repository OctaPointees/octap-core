import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedMember, seedOrganization, seedProgram } from './support/db.js';

const REDIRECT = 'http://localhost:6274/oauth/callback';
const RESOURCE = 'http://localhost:4100/mcp';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const NO_SUBMISSION = '00000000-0000-4000-8000-000000000000';
const reward = { code: 'coffee', title: 'Free coffee', discountType: 'FREE_ITEM', pointsCost: 100 };

describe('MCP writes: mcp:write, confirmation and idempotency (OCT-314)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ownerOf: string;
  let developerOf: string;
  let userId: string;
  let memberId: string;

  beforeAll(async () => {
    // A fake Google token is `<subject>` or `<subject>|<nonce>`.
    ctx = await createTestApp(undefined, {
      verify: async (token: string) => {
        const [subject, nonce] = token.split('|');
        return {
          subject,
          email: `${subject}@example.com`,
          fullName: subject,
          avatarUrl: null,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          ...(nonce ? { nonce } : {}),
        };
      },
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    vi.stubEnv('MCP_OAUTH_ISSUER_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('MCP_OAUTH_SIGNING_KEY', Buffer.alloc(32, 3).toString('base64'));
    vi.stubEnv('CONSOLE_GOOGLE_CLIENT_ID', 'google-client');
    await resetDb(ctx.db);
    ownerOf = (await seedOrganization(ctx.db, { name: 'A Coffee' })).id;
    developerOf = (await seedOrganization(ctx.db, { name: 'B Bakery' })).id;
    await seedProgram(ctx.db, ownerOf);
    await seedProgram(ctx.db, developerOf);
    userId = (await ctx.http().post('/v1/console/auth/google').send({ idToken: 'owner' }).expect(201)).body.user.id;
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: ownerOf, systemUserId: userId, role: 'OWNER' },
      { organizationId: developerOf, systemUserId: userId, role: 'BUSINESS_DEVELOPER' },
    ]);
    memberId = (await seedMember(ctx.db, ownerOf)).memberId;
  });

  /** Signs in from a host that asks for `scope`, ticking "allow changes" or not, for one organization. */
  async function signIn(options: { scope: string; allowWrite: boolean; organizationId: string; host?: string }) {
    const clientId = (
      await ctx
        .http()
        .post('/oauth/register')
        .send({ client_name: options.host ?? 'Inspector', redirect_uris: [REDIRECT] })
        .expect(201)
    ).body.client_id as string;
    const page = await ctx
      .http()
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        scope: options.scope,
        resource: RESOURCE,
      })
      .expect(200);
    const { requestId } = JSON.parse(
      /<script id="config" type="application\/json">(.*?)<\/script>/.exec(page.text)![1],
    );
    await ctx
      .http()
      .post('/oauth/authorize/google')
      .send({ requestId, credential: `owner|${requestId}`, allowWrite: options.allowWrite })
      .expect(200);
    const { redirectTo } = (
      await ctx
        .http()
        .post('/oauth/authorize/organization')
        .send({ requestId, organizationId: options.organizationId })
        .expect(200)
    ).body;
    const tokens = await ctx
      .http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: new URL(redirectTo).searchParams.get('code'),
        code_verifier: VERIFIER,
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
      .expect(200);
    return { token: tokens.body.access_token as string, scope: tokens.body.scope as string, page: page.text };
  }

  const vouchers = (organizationId: string) => `/v1/console/organizations/${organizationId}/vouchers`;
  const prepare = (token: string, organizationId: string, change: Record<string, unknown>) =>
    ctx
      .http()
      .post(`/v1/console/organizations/${organizationId}/mcp/confirmations`)
      .set('Authorization', `Bearer ${token}`)
      .send(change);
  const apply = (
    token: string,
    method: 'post' | 'patch',
    path: string,
    body: Record<string, unknown>,
    confirmationId?: string,
  ) => {
    const request = ctx.http()[method](path).set('Authorization', `Bearer ${token}`);
    return (confirmationId ? request.set('X-Mcp-Confirmation', confirmationId) : request).send(body);
  };

  it('keeps a connection read-only unless the user ticks "allow changes"', async () => {
    const asked = await signIn({ scope: 'mcp mcp:write', allowWrite: false, organizationId: ownerOf });
    expect(asked.page).toContain('id="allow-write"');
    expect(asked.scope).toBe('mcp');
    await prepare(asked.token, ownerOf, { method: 'POST', path: vouchers(ownerOf), body: reward, summary: 'x' }).expect(
      403,
    );
    await apply(asked.token, 'post', vouchers(ownerOf), reward, 'anything').expect(403);

    // A host that doesn't ask for mcp:write never gets the choice.
    const plain = await signIn({ scope: 'mcp', allowWrite: true, organizationId: ownerOf });
    expect(plain.page).not.toContain('id="allow-write"');
    expect(plain.scope).toBe('mcp');

    const allowed = await signIn({ scope: 'mcp mcp:write', allowWrite: true, organizationId: ownerOf });
    expect(allowed.scope).toBe('mcp mcp:write');
    expect(
      (await ctx.http().get('/v1/console/mcp/token').set('Authorization', `Bearer ${allowed.token}`).expect(200)).body
        .scopes,
    ).toEqual(['mcp', 'mcp:write']);
  });

  it('makes a confirmed change once, and refuses unconfirmed, altered and other routes', async () => {
    const { token } = await signIn({ scope: 'mcp mcp:write', allowWrite: true, organizationId: ownerOf });

    // A route that doesn't opt in, even with mcp:write.
    await apply(token, 'patch', `/v1/console/organizations/${ownerOf}/members/${memberId}`, {
      status: 'BLOCKED',
    }).expect(403);
    // No confirmation.
    await apply(token, 'post', vouchers(ownerOf), reward).expect(403);
    // Preparing only reaches this organization's console routes.
    await prepare(token, ownerOf, { method: 'POST', path: vouchers(developerOf), body: reward, summary: 'x' }).expect(
      400,
    );
    await prepare(token, ownerOf, { method: 'GET', path: vouchers(ownerOf), summary: 'x' }).expect(400);

    // An altered request burns the confirmation: it changes nothing, and the original can't follow.
    const altered = (
      await prepare(token, ownerOf, {
        method: 'POST',
        path: vouchers(ownerOf),
        body: reward,
        summary: 'Create coffee',
      }).expect(201)
    ).body.confirmationId as string;
    await apply(token, 'post', vouchers(ownerOf), { ...reward, pointsCost: 1 }, altered).expect(403);
    await apply(token, 'post', vouchers(ownerOf), reward, altered).expect(409);

    const prepared = await prepare(token, ownerOf, {
      method: 'POST',
      path: vouchers(ownerOf),
      body: reward,
      summary: 'Create a draft voucher "Free coffee" for 100 points.',
    }).expect(201);
    const confirmationId = prepared.body.confirmationId as string;
    expect(prepared.body).toMatchObject({ method: 'POST', path: vouchers(ownerOf), body: reward });
    // The host reads it back to show the user.
    expect(
      (
        await ctx
          .http()
          .get(`/v1/console/organizations/${ownerOf}/mcp/confirmations/${confirmationId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body.summary,
    ).toBe('Create a draft voucher "Free coffee" for 100 points.');
    // Another MCP host of the same user can't use it.
    const other = await signIn({ scope: 'mcp mcp:write', allowWrite: true, organizationId: ownerOf, host: 'Claude' });
    await ctx
      .http()
      .get(`/v1/console/organizations/${ownerOf}/mcp/confirmations/${confirmationId}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);

    const created = await apply(token, 'post', vouchers(ownerOf), reward, confirmationId).expect(201);
    expect(created.body).toMatchObject({ code: 'coffee', status: 'DRAFT' });
    // A retry gets the same answer and makes nothing new.
    const retried = await apply(token, 'post', vouchers(ownerOf), reward, confirmationId).expect(201);
    expect(retried.body.id).toBe(created.body.id);
    const rows = await ctx.db.select().from(schema.vouchers).where(eq(schema.vouchers.organizationId, ownerOf));
    expect(rows).toHaveLength(1);

    // Recorded as the user, like a change from the console.
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.organizationId, ownerOf), eq(schema.auditLog.action, 'voucher.created')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'USER', actorId: userId, targetId: created.body.id });
  });

  it('lets an Owner activate a voucher as they saw it while approval is required', async () => {
    const { token } = await signIn({ scope: 'mcp mcp:write', allowWrite: true, organizationId: ownerOf });
    await ctx
      .http()
      .patch(`/v1/console/organizations/${ownerOf}/settings`)
      .set('Authorization', 'Bearer owner')
      .send({ voucherApprovalRequired: true })
      .expect(200);
    const confirmed = async (method: 'post' | 'patch', path: string, body: Record<string, unknown>) => {
      const prepared = await prepare(token, ownerOf, { method: method.toUpperCase(), path, body, summary: 'Change' });
      expect(prepared.status).toBe(201);
      return apply(token, method, path, body, prepared.body.confirmationId);
    };
    const created = await confirmed('post', vouchers(ownerOf), reward);
    expect(created.status).toBe(201);
    const path = `${vouchers(ownerOf)}/${created.body.id}`;

    // What activate_voucher sends: the voucher's updatedAt as the user saw it.
    const stale = await confirmed('patch', path, { status: 'ACTIVE', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    const activated = await confirmed('patch', path, { status: 'ACTIVE', expectedUpdatedAt: created.body.updatedAt });
    expect(activated.status).toBe(200);
    expect(activated.body.publishStatus).toBe('PUBLISHING');
  });

  it("keeps Core's persona rules: a Developer can't approve through MCP", async () => {
    const { token } = await signIn({ scope: 'mcp mcp:write', allowWrite: true, organizationId: developerOf });
    const draft = (
      await prepare(token, developerOf, {
        method: 'POST',
        path: vouchers(developerOf),
        body: reward,
        summary: 'Create',
      }).expect(201)
    ).body;
    const voucherId = (await apply(token, 'post', vouchers(developerOf), reward, draft.confirmationId).expect(201)).body
      .id;
    const approve = `${vouchers(developerOf)}/${voucherId}/approve`;
    const decision = (
      await prepare(token, developerOf, {
        method: 'POST',
        path: approve,
        body: { approvalRequestId: NO_SUBMISSION },
        summary: 'Approve',
      }).expect(201)
    ).body;
    await apply(token, 'post', approve, { approvalRequestId: NO_SUBMISSION }, decision.confirmationId).expect(403);
  });
});
