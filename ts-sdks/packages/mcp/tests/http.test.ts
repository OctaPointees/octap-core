import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpHandler } from '../src/http.js';

const CORE = 'https://core.test';
const PUBLIC = 'http://localhost:4100';
const ORG = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const GOOD = 'octap_mcp_good';
const OTHER_AUDIENCE = 'octap_mcp_other_audience';

const oauthMetadata = {
  issuer: CORE,
  authorization_endpoint: `${CORE}/oauth/authorize`,
  token_endpoint: `${CORE}/oauth/token`,
  registration_endpoint: `${CORE}/oauth/register`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};

const introspection = (resource: string) => ({
  active: true,
  clientId: 'mcpc_client',
  scopes: ['mcp'],
  userId: 'user-1',
  organizationId: ORG,
  persona: 'BUSINESS_OWNER',
  resource,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

/** Stands in for Core: the token check and the console member routes, recording what was called. */
function fakeCore() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    if (url === `${CORE}/v1/console/mcp/token`) {
      if (authorization === `Bearer ${GOOD}`) return Response.json(introspection(`${PUBLIC}/mcp`));
      if (authorization === `Bearer ${OTHER_AUDIENCE}`) return Response.json(introspection('http://elsewhere/mcp'));
      return Response.json({ message: 'invalid' }, { status: 401 });
    }
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
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_member_balance',
      'list_member_transactions',
      'list_member_vouchers',
    ]);
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
