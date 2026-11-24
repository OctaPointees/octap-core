import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AssistantStreamEvent } from '@octap/contracts';
import { McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';
import { AnthropicAssistantClient } from '#infra/clients/anthropic/anthropic-assistant.client.js';
import type { AssistantRunEvent, AssistantRunRequest } from '#infra/clients/assistant-model.js';
import { OpenAiAssistantClient } from '#infra/clients/openai/openai-assistant.client.js';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedMember, seedOrganization } from './support/db.js';

const MCP_ORIGIN = 'https://mcp.octap.test';
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, modelCalls: 1 };

/** Reads the whole SSE body as text; supertest does not buffer `text/event-stream` by itself. */
const sse = (res: unknown, done: (error: Error | null, body: string) => void) => {
  const stream = res as NodeJS.ReadableStream;
  let body = '';
  stream.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  stream.on('end', () => done(null, body));
};
const events = (body: string): AssistantStreamEvent[] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));

describe('Dashboard assistant route (OCT-308)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgA: string;
  let orgB: string;
  let memberA: string;
  let owner: string;
  /** Stands in for Claude: each test scripts what "Claude" does with the turn's MCP token. */
  let script: (request: AssistantRunRequest) => AsyncGenerator<AssistantRunEvent>;
  const providers: string[] = [];
  const model = (provider: string) => ({
    run: (request: AssistantRunRequest) => {
      providers.push(provider);
      return script(request);
    },
  });

  beforeAll(async () => {
    ctx = await createTestApp(
      undefined,
      {
        verify: async (token: string) => ({
          subject: token,
          email: `${token}@example.com`,
          fullName: token,
          avatarUrl: null,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
      undefined,
      [
        { provide: AnthropicAssistantClient, useValue: model('anthropic') },
        { provide: OpenAiAssistantClient, useValue: model('openai') },
      ],
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-must-never-leave-core');
    vi.stubEnv('OCTAP_MCP_PUBLIC_URL', MCP_ORIGIN);
    await resetDb(ctx.db);
    orgA = (await seedOrganization(ctx.db, { name: 'A Coffee' })).id;
    orgB = (await seedOrganization(ctx.db, { name: 'B Bakery' })).id;
    const signIn = async (subject: string) =>
      (await ctx.http().post('/v1/console/auth/google').send({ idToken: subject }).expect(201)).body.user.id as string;
    owner = await signIn('owner');
    const developer = await signIn('developer');
    await signIn('outsider');
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgA, systemUserId: owner, role: 'OWNER' },
      { organizationId: orgA, systemUserId: developer, role: 'BUSINESS_DEVELOPER' },
    ]);
    memberA = (await seedMember(ctx.db, orgA)).memberId;
    script = async function* () {
      yield { type: 'text', text: 'Hello.' };
      yield { type: 'end', reason: 'complete', usage };
    };
  });

  const ask = (
    credential: string,
    organizationId: string,
    body: unknown = { message: 'How many points does Lan have?' },
  ) =>
    ctx
      .http()
      .post(`/v1/console/organizations/${organizationId}/assistant/messages`)
      .set('Authorization', `Bearer ${credential}`)
      .send(body as object)
      .buffer(true)
      .parse(sse);
  const read = (token: string, path: string) => ctx.http().get(path).set('Authorization', `Bearer ${token}`);

  it('streams an answer whose tool calls reach Core as the Owner, for this organization only', async () => {
    let token = '';
    script = async function* (request) {
      token = request.mcp.token;
      expect(request.mcp.url).toBe(`${MCP_ORIGIN}/mcp`);
      // What the MCP server does on each tool call: introspect, then read with the same token.
      expect((await read(token, '/v1/console/mcp/token').expect(200)).body).toMatchObject({
        clientId: 'octap-dashboard-assistant',
        organizationId: orgA,
        persona: 'BUSINESS_OWNER',
        resource: `${MCP_ORIGIN}/mcp`,
      });
      yield { type: 'tool_call', id: 't1', name: 'get_member' };
      await read(token, `/v1/console/organizations/${orgA}/members/${memberA}`).expect(200);
      await read(token, `/v1/console/organizations/${orgA}/staff`).expect(200);
      yield { type: 'tool_result', toolUseId: 't1', isError: false };
      // Another organization's data is out of reach.
      await read(token, `/v1/console/organizations/${orgB}/members`).expect(403);
      yield { type: 'text', text: 'Lan has 42 points.' };
      yield { type: 'end', reason: 'complete', usage };
    };
    const res = await ask('owner', orgA).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(events(res.body as string)).toEqual([
      { type: 'tool', name: 'get_member' },
      { type: 'text', text: 'Lan has 42 points.' },
      { type: 'done', reason: 'complete' },
    ]);
    expect(res.body).toContain('event: text\ndata: ');
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain('sk-ant');
    // The turn's token dies with the turn.
    await read(token, '/v1/console/mcp/token').expect(401);
  });

  it("gives a Developer a Developer token, which Core refuses on the Owner's routes", async () => {
    script = async function* (request) {
      const introspection = (await read(request.mcp.token, '/v1/console/mcp/token').expect(200)).body;
      expect(introspection.persona).toBe('BUSINESS_DEVELOPER');
      await read(request.mcp.token, `/v1/console/organizations/${orgA}/staff`).expect(403);
      yield { type: 'end', reason: 'complete', usage };
    };
    await ask('developer', orgA).expect(200);
  });

  it('cuts the assistant off when the membership is suspended mid-conversation', async () => {
    script = async function* (request) {
      yield { type: 'tool_call', id: 't1', name: 'find_member' };
      await ctx.db
        .update(schema.organizationMemberships)
        .set({ status: 'INACTIVE' })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, orgA),
            eq(schema.organizationMemberships.systemUserId, owner),
          ),
        );
      await read(request.mcp.token, `/v1/console/organizations/${orgA}/members`).expect(401);
      yield { type: 'tool_result', toolUseId: 't1', isError: true };
      yield { type: 'text', text: 'Your access to this organization changed.' };
      yield { type: 'end', reason: 'complete', usage };
    };
    expect(events((await ask('owner', orgA).expect(200)).body as string)).toContainEqual({
      type: 'tool_error',
      name: 'find_member',
    });
  });

  it('answers through OpenAI when ASSISTANT_PROVIDER is openai, with the same token rules', async () => {
    vi.stubEnv('ASSISTANT_PROVIDER', 'openai');
    await ask('owner', orgA).expect(503);
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-must-never-leave-core');
    vi.stubEnv('OPENAI_MODEL', 'gpt-test');
    providers.length = 0;
    script = async function* (request) {
      expect((await read(request.mcp.token, '/v1/console/mcp/token').expect(200)).body.persona).toBe('BUSINESS_OWNER');
      yield { type: 'text', text: 'Hello from OpenAI.' };
      yield { type: 'end', reason: 'complete', usage };
    };
    const res = await ask('owner', orgA).expect(200);
    expect(providers).toEqual(['openai']);
    expect(events(res.body as string)[0]).toEqual({ type: 'text', text: 'Hello from OpenAI.' });
    expect(res.body).not.toContain('sk-openai');
  });

  it('refuses an MCP token and a user of another organization', async () => {
    const mcpToken = await ctx.app.get(McpOAuthService).issueAssistantToken({
      userId: owner,
      organizationId: orgA,
      persona: 'BUSINESS_OWNER',
      resource: `${MCP_ORIGIN}/mcp`,
    });
    await ask(mcpToken, orgA).expect(403);
    await ask('outsider', orgA).expect(403);
    await ask('owner', orgB).expect(403);
  });

  it('answers 503 without an Anthropic key, and checks the message, history and rate limit', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await ask('owner', orgA).expect(503);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-must-never-leave-core');

    await ask('owner', orgA, { message: 'x'.repeat(4001) }).expect(400);
    await ask('owner', orgA, { message: 'Hi', history: [{ role: 'assistant', text: 'Earlier' }] }).expect(400);

    // 10 per user per minute by default.
    for (let i = 0; i < 10; i++) await ask('developer', orgA).expect(200);
    const limited = await ask('developer', orgA).expect(429);
    expect(JSON.stringify(limited.body)).not.toContain('sk-ant');
  });
});
