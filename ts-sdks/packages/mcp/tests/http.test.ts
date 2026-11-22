import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { consoleCoreClient } from '../src/console-client.js';
import { createHttpHandler } from '../src/http.js';
import { createServer } from '../src/server.js';

const CORE = 'https://core.test';
const PUBLIC = 'http://localhost:4100';
const ORG = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const GOOD = 'octap_mcp_good';
const DEVELOPER = 'octap_mcp_developer';
const OTHER_AUDIENCE = 'octap_mcp_other_audience';

const oauthMetadata = {
  issuer: CORE,
  authorization_endpoint: `${CORE}/oauth/authorize`,
  token_endpoint: `${CORE}/oauth/token`,
  registration_endpoint: `${CORE}/oauth/register`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};

const introspection = (resource: string, persona = 'BUSINESS_OWNER') => ({
  active: true,
  clientId: 'mcpc_client',
  scopes: ['mcp'],
  userId: 'user-1',
  organizationId: ORG,
  persona,
  resource,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

const OWNER_TOOLS = [
  'get_connection',
  'get_member_balance',
  'get_refund_policy',
  'list_api_keys',
  'list_member_transactions',
  'list_member_vouchers',
];
const DEVELOPER_TOOLS = ['get_connection', 'get_member_balance', 'list_api_keys', 'list_member_transactions'];

/**
 * Stands in for Core: the token check and the console routes, recording what was called. Like Core,
 * it answers the refund policy to the Owner only, whatever tool map the MCP server uses.
 */
function fakeCore() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    const persona =
      authorization === `Bearer ${GOOD}`
        ? 'BUSINESS_OWNER'
        : authorization === `Bearer ${DEVELOPER}`
          ? 'BUSINESS_DEVELOPER'
          : null;
    if (url === `${CORE}/v1/console/mcp/token`) {
      if (persona) return Response.json(introspection(`${PUBLIC}/mcp`, persona));
      if (authorization === `Bearer ${OTHER_AUDIENCE}`) return Response.json(introspection('http://elsewhere/mcp'));
      return Response.json({ message: 'invalid' }, { status: 401 });
    }
    if (!persona) return Response.json({ message: 'invalid' }, { status: 401 });
    if (url === `${CORE}/v1/console/me`)
      return Response.json({
        user: { id: 'user-1', email: 'owner@example.test', fullName: 'Test Owner', systemRole: 'SYSTEM_USER' },
        organizations: [{ organizationId: ORG, name: 'Coffee', slug: 'coffee', persona }],
        expiresAt: '2026-11-22T16:00:00.000Z',
      });
    if (url === `${CORE}/v1/console/organizations/${ORG}/refund-policy`)
      return persona === 'BUSINESS_OWNER'
        ? Response.json({
            version: 2,
            allowUnused: true,
            allowExpired: false,
            allowRedeemed: false,
            restockUnused: true,
            refundWindowDays: 14,
            reason: 'Two-week window',
            createdByUserId: 'user-1',
            createdAt: '2026-11-01T00:00:00.000Z',
          })
        : Response.json({ message: 'Organization access is required' }, { status: 403 });
    if (url === `${CORE}/v1/console/organizations/${ORG}/api-credentials`)
      return Response.json([
        {
          id: 'key-1',
          name: 'POS',
          keyPrefix: 'octap_live_ab',
          scopes: ['read', 'write'],
          status: 'ACTIVE',
          createdAt: '2026-10-01T00:00:00.000Z',
          lastUsedAt: null,
          keyHash: 'must-never-reach-the-model',
        },
      ]);
    if (url === `${CORE}/v1/console/organizations/${ORG}/members/${MEMBER}/transactions?limit=5`)
      return Response.json({
        items: [{ id: 'tx-1', transactionType: 'EARN', status: 'CONFIRMED', pointsAmount: 10 }],
        nextCursor: null,
      });
    if (url === `${CORE}/v1/console/organizations/${ORG}/members/${MEMBER}`)
      return Response.json({ id: MEMBER, balance: { organizationEndUserId: MEMBER, confirmedBalance: 42 } });
    return Response.json({ message: 'not found' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function handler() {
  return createHttpHandler({ apiUrl: CORE, publicUrl: PUBLIC, oauthMetadata });
}

/** An MCP client whose HTTP requests go straight into the handler, with an optional bearer token. */
async function connect(serve: (request: Request) => Promise<Response>, token?: string) {
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), {
    fetch: (input, init) => serve(new Request(input, init)),
    ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(transport);
  return client;
}

describe('remote MCP over HTTP (OCT-293)', () => {
  it('publishes protected resource metadata that points at Core', async () => {
    fakeCore();
    const serve = await handler();
    const response = await serve(new Request(`${PUBLIC}/.well-known/oauth-protected-resource/mcp`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [CORE] });
  });

  it('answers 401 with a discovery challenge without a valid, audience-bound token', async () => {
    fakeCore();
    const serve = await handler();
    const post = (token?: string) =>
      serve(
        new Request(`${PUBLIC}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }),
      );
    for (const token of [undefined, 'octap_mcp_revoked', OTHER_AUDIENCE]) {
      const response = await post(token);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
  });

  it('refuses a request for another host', async () => {
    fakeCore();
    const serve = await handler();
    const response = await serve(
      new Request('http://attacker.test/mcp', { method: 'POST', headers: { Host: 'attacker.test' } }),
    );
    expect(response.status).toBe(403);
  });

  it('lists tools and reads through the console routes of the token organization, as the user', async () => {
    const { calls } = fakeCore();
    const client = await connect(await handler(), GOOD);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(OWNER_TOOLS);
    const history = await client.callTool({
      name: 'list_member_transactions',
      arguments: { memberId: MEMBER, limit: 5 },
    });
    expect(history.isError).toBeFalsy();
    expect(JSON.stringify(history.content)).toContain('tx-1');
    const balance = await client.callTool({ name: 'get_member_balance', arguments: { memberId: MEMBER } });
    expect(JSON.stringify(balance.content)).toContain('42');

    const coreReads = calls.filter((call) => call.url.includes('/members/'));
    expect(coreReads.length).toBeGreaterThan(0);
    for (const call of coreReads) {
      expect(call.url.startsWith(`${CORE}/v1/console/organizations/${ORG}/`)).toBe(true);
      expect(call.authorization).toBe(`Bearer ${GOOD}`);
    }
    await client.close();
  });
});

describe('persona tool sets and prompts (OCT-294)', () => {
  it('gives an Owner every tool and prompt, and says which persona the session acts as', async () => {
    fakeCore();
    const client = await connect(await handler(), GOOD);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(OWNER_TOOLS);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual([
      'check_member_transactions',
      'review_api_keys',
      'summarize_member',
    ]);
    expect(client.getInstructions()).toContain('as Business Owner');
    await client.close();
  });

  it('gives a Developer only the Developer tools and prompts', async () => {
    fakeCore();
    const client = await connect(await handler(), DEVELOPER);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(DEVELOPER_TOOLS);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual([
      'check_member_transactions',
      'review_api_keys',
    ]);
    expect(client.getInstructions()).toContain('as Business Developer');
    await client.close();
  });

  it('refuses at the MCP server a tool outside the caller set, without calling Core', async () => {
    const { calls } = fakeCore();
    const client = await connect(await handler(), DEVELOPER);
    const refused = await client.callTool({ name: 'get_refund_policy', arguments: {} }).then(
      (outcome) => outcome.isError === true,
      () => true,
    );
    expect(refused).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/refund-policy'))).toBe(false);
    await client.close();
  });

  it('lets server options narrow the persona set but never widen it', async () => {
    fakeCore();
    const serve = await createHttpHandler({
      apiUrl: CORE,
      publicUrl: PUBLIC,
      oauthMetadata,
      server: { tools: ['get_connection', 'get_refund_policy'] },
    });
    const developer = await connect(serve, DEVELOPER);
    expect((await developer.listTools()).tools.map((tool) => tool.name)).toEqual(['get_connection']);
    await developer.close();
  });

  it('still gets Core 403 when a wrong map gives a Developer an Owner-only tool', async () => {
    fakeCore();
    // Deliberately wrong map: the Developer is handed the Owner-only refund policy.
    const server = createServer({
      tools: ['get_refund_policy'],
      client: consoleCoreClient(CORE, DEVELOPER, ORG),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const outcome = await client.callTool({ name: 'get_refund_policy', arguments: {} });
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.content)).toContain('Core denied this read');
    expect(JSON.stringify(outcome.content)).not.toContain('allowUnused');
    await client.close();
    await server.close();
  });

  it('tells the user which organization and persona the session is connected as', async () => {
    fakeCore();
    const client = await connect(await handler(), DEVELOPER);
    const outcome = await client.callTool({ name: 'get_connection', arguments: {} });
    expect(outcome.isError).toBeFalsy();
    const text = JSON.stringify(outcome.content);
    expect(text).toContain('Coffee');
    expect(text).toContain('BUSINESS_DEVELOPER');
    expect(text).not.toContain('owner@example.test');
    await client.close();
  });

  it('reads the refund policy for an Owner and lists API keys without secrets', async () => {
    fakeCore();
    const client = await connect(await handler(), GOOD);
    const policy = JSON.stringify((await client.callTool({ name: 'get_refund_policy', arguments: {} })).content);
    expect(policy).toContain('refundWindowDays');
    expect(policy).not.toContain('createdByUserId');
    const keys = JSON.stringify((await client.callTool({ name: 'list_api_keys', arguments: {} })).content);
    expect(keys).toContain('octap_live_ab');
    expect(keys).not.toContain('must-never-reach-the-model');
    expect(keys).not.toContain('key-1');
    await client.close();
  });
});
