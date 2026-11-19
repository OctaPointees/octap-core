import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedMember, seedOrganization } from './support/db.js';

const REDIRECT = 'http://localhost:6274/oauth/callback';
const RESOURCE = 'http://localhost:4100/mcp';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('MCP OAuth sign-in (OCT-293)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgA: string;
  let orgB: string;
  let memberA: string;
  let memberB: string;
  let userId: string;

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
    // Read per request, and vitest unstubs env after every test, so stub before each one.
    vi.stubEnv('MCP_OAUTH_ISSUER_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('MCP_OAUTH_SIGNING_KEY', Buffer.alloc(32, 3).toString('base64'));
    vi.stubEnv('CONSOLE_GOOGLE_CLIENT_ID', 'google-client');
    await resetDb(ctx.db);
    orgA = (await seedOrganization(ctx.db, { name: 'A Coffee' })).id;
    orgB = (await seedOrganization(ctx.db, { name: 'B Bakery' })).id;
    userId = (await ctx.http().post('/v1/console/auth/google').send({ idToken: 'owner' }).expect(201)).body.user.id;
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgA, systemUserId: userId, role: 'OWNER' },
      { organizationId: orgB, systemUserId: userId, role: 'BUSINESS_DEVELOPER' },
    ]);
    memberA = (await seedMember(ctx.db, orgA)).memberId;
    memberB = (await seedMember(ctx.db, orgB)).memberId;
  });

  const register = async () =>
    (
      await ctx
        .http()
        .post('/oauth/register')
        .send({ client_name: 'Inspector', redirect_uris: [REDIRECT] })
        .expect(201)
    ).body.client_id as string;

  const authorizeQuery = (clientId: string) => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: RESOURCE,
  });

  /** Registers, signs in as `owner`, picks organization A and exchanges the code. */
  async function signIn() {
    const clientId = await register();
    const page = await ctx.http().get('/oauth/authorize').query(authorizeQuery(clientId)).expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['x-frame-options']).toBe('DENY');
    const { requestId } = JSON.parse(
      /<script id="config" type="application\/json">(.*?)<\/script>/.exec(page.text)![1],
    );
    const choice = await ctx
      .http()
      .post('/oauth/authorize/google')
      .send({ requestId, credential: `owner|${requestId}` })
      .expect(200);
    expect(choice.body.organizations.map((o: { organizationId: string }) => o.organizationId).sort()).toEqual(
      [orgA, orgB].sort(),
    );
    const { redirectTo } = (
      await ctx.http().post('/oauth/authorize/organization').send({ requestId, organizationId: orgA }).expect(200)
    ).body;
    const redirect = new URL(redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('state-1');
    const code = redirect.searchParams.get('code')!;
    // MCP hosts send the token request form-encoded.
    const tokens = await ctx
      .http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      })
      .expect(200);
    return { clientId, code, token: tokens.body.access_token as string, tokens: tokens.body };
  }

  const read = (token: string, path: string) => ctx.http().get(path).set('Authorization', `Bearer ${token}`);

  it('publishes authorization server metadata', async () => {
    const metadata = (await ctx.http().get('/.well-known/oauth-authorization-server').expect(200)).body;
    expect(metadata).toMatchObject({
      issuer: 'http://127.0.0.1:3000',
      token_endpoint: 'http://127.0.0.1:3000/oauth/token',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('signs in with Google, then reads only the chosen organization, read-only', async () => {
    const { token, tokens, code, clientId } = await signIn();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });

    expect((await read(token, '/v1/console/mcp/token').expect(200)).body).toMatchObject({
      active: true,
      clientId,
      userId,
      organizationId: orgA,
      persona: 'BUSINESS_OWNER',
      resource: RESOURCE,
    });
    const me = (await read(token, '/v1/console/me').expect(200)).body;
    expect(me.organizations.map((o: { organizationId: string }) => o.organizationId)).toEqual([orgA]);

    await read(token, `/v1/console/organizations/${orgA}/members/${memberA}/transactions`).expect(200);
    // The same user is a Developer of B, but this token is for A.
    await read(token, `/v1/console/organizations/${orgB}/members/${memberB}/transactions`).expect(403);
    await read(token, `/v1/console/organizations/${orgA}/members/${memberB}/transactions`).expect(404);
    await ctx
      .http()
      .patch(`/v1/console/organizations/${orgA}/members/${memberA}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'BLOCKED' })
      .expect(403);
    await read(token, '/v1/platform/organization-requests').expect(403);

    // A code works once.
    const replay = await ctx
      .http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
      .expect(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('refuses missing, unknown, revoked and no-longer-authorized tokens', async () => {
    await ctx.http().get('/v1/console/mcp/token').expect(401);
    await read('octap_mcp_unknown', '/v1/console/mcp/token').expect(401);
    // A Google sign-in is not an MCP token.
    await read('owner', '/v1/console/mcp/token').expect(401);

    const revoked = (await signIn()).token;
    await ctx.http().post('/oauth/revoke').type('form').send({ token: revoked }).expect(200);
    await read(revoked, '/v1/console/mcp/token').expect(401);

    const suspended = (await signIn()).token;
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'INACTIVE' })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, orgA),
          eq(schema.organizationMemberships.systemUserId, userId),
        ),
      );
    await read(suspended, `/v1/console/organizations/${orgA}/members/${memberA}/transactions`).expect(401);
  });

  it('refuses a Google token minted for something else, a wrong verifier and an unregistered redirect', async () => {
    const clientId = await register();
    const page = await ctx.http().get('/oauth/authorize').query(authorizeQuery(clientId)).expect(200);
    const { requestId } = JSON.parse(
      /<script id="config" type="application\/json">(.*?)<\/script>/.exec(page.text)![1],
    );
    await ctx.http().post('/oauth/authorize/google').send({ requestId, credential: 'owner' }).expect(401);
    await ctx.http().post('/oauth/authorize/google').send({ requestId, credential: 'owner|other' }).expect(401);

    const bad = await ctx
      .http()
      .get('/oauth/authorize')
      .query({ ...authorizeQuery(clientId), redirect_uri: 'https://evil.example/cb' })
      .expect(400);
    expect(bad.text).toContain('Cannot sign in');
    expect(bad.text).not.toContain('evil.example');

    const { requestId: second } = JSON.parse(
      /<script id="config" type="application\/json">(.*?)<\/script>/.exec(
        (await ctx.http().get('/oauth/authorize').query(authorizeQuery(clientId)).expect(200)).text,
      )![1],
    );
    await ctx
      .http()
      .post('/oauth/authorize/google')
      .send({ requestId: second, credential: `owner|${second}` });
    const { redirectTo } = (
      await ctx
        .http()
        .post('/oauth/authorize/organization')
        .send({ requestId: second, organizationId: orgA })
        .expect(200)
    ).body;
    const wrong = await ctx
      .http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: new URL(redirectTo).searchParams.get('code'),
        code_verifier: 'w'.repeat(64),
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
      .expect(400);
    expect(wrong.body).toMatchObject({ error: 'invalid_grant' });
  });
});
