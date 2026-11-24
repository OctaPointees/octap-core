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

const DEVELOPER_TOOLS = [
  'find_member',
  'get_budget',
  'get_connection',
  'get_member',
  'get_member_balance',
  'get_organization',
  'get_voucher',
  'get_voucher_batch',
  'list_api_keys',
  'list_member_transactions',
  'list_member_vouchers',
  'list_voucher_batches',
  'list_vouchers',
];
const OWNER_TOOLS = [
  ...DEVELOPER_TOOLS,
  'get_refund_policy',
  'get_refund_policy_history',
  'list_invitations',
  'list_staff',
  'list_webhook_deliveries',
  'list_webhook_endpoints',
].sort();
const VOUCHER = '33333333-3333-4333-8333-333333333333';
const BATCH = '44444444-4444-4444-8444-444444444444';
const ENDPOINT = '55555555-5555-4555-8555-555555555555';
const voucher = (id: string, status: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG,
  code: title.toUpperCase().replace(/[^A-Z0-9]+/g, '-'),
  title,
  description: 'A treat',
  pointsCost: 300,
  discountType: 'FREE_ITEM',
  discountValue: null,
  terms: { schema: 'octap.benefit.v1', kind: 'FREE_ITEM', item: 'Latte' },
  publishStatus: status === 'ACTIVE' ? 'PUBLISHED' : 'NOT_PUBLISHED',
  suiTermsId: null,
  totalSupply: 100,
  perMemberLimit: 1,
  claimedCount: 40,
  status,
  startsAt: null,
  expiresAt: '2027-12-31T16:59:59.000Z',
  validForDays: 30,
  metadata: { internal: 'must-never-reach-the-model' },
  approval: null,
  batchId: BATCH,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

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
    const org = `${CORE}/v1/console/organizations/${ORG}`;
    const ownerOnly = (body: unknown) =>
      persona === 'BUSINESS_OWNER'
        ? Response.json(body)
        : Response.json({ message: 'Organization access is required' }, { status: 403 });
    if (url === `${org}/members/${MEMBER}`)
      return Response.json({
        id: MEMBER,
        endUserId: 'end-user-1',
        displayName: 'Lan Nguyen',
        email: 'lan@example.test',
        phoneNumber: '+84900000001',
        status: 'ACTIVE',
        externalMemberId: 'POS-77',
        metadata: { cccd: '079123456789' },
        joinedAt: '2026-10-01T00:00:00.000Z',
        balance: { organizationEndUserId: MEMBER, confirmedBalance: 42 },
      });
    if (url === `${org}/members?q=Lan&limit=20`)
      return Response.json({
        items: [
          {
            id: MEMBER,
            endUserId: 'end-user-1',
            displayName: 'Lan Nguyen',
            email: 'lan@example.test',
            phoneNumber: null,
            status: 'ACTIVE',
            externalMemberId: 'POS-77',
            metadata: { cccd: '079123456789' },
            joinedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'next-page',
      });
    if (url === `${org}/members/${MEMBER}/transactions?limit=2`)
      return Response.json({
        items: [{ id: 'tx-9', transactionType: 'EARN', status: 'PENDING', pointsAmount: null }],
        nextCursor: null,
      });
    if (url === `${org}/members/${MEMBER}/vouchers`)
      return Response.json([
        { id: 'own-1', voucherId: VOUCHER, serialCode: 'SERIAL-must-never-reach-the-model', status: 'CLAIMED' },
        { id: 'own-2', voucherId: VOUCHER, serialCode: 'SERIAL-2', status: 'USED' },
        { id: 'own-3', voucherId: VOUCHER, serialCode: 'SERIAL-3', status: 'USED' },
      ]);
    if (url === org)
      return Response.json({
        id: ORG,
        name: 'Coffee',
        slug: 'coffee',
        legalName: 'Coffee JSC',
        taxId: 'TAX-must-never-reach-the-model',
        organizationType: 'COMPANY',
        representativeName: 'Rep',
        logoUrl: null,
        voucherApprovalRequired: true,
        nationalIdLast4: '6789',
        status: 'ACTIVE',
        persona,
      });
    if (url === `${org}/vouchers`)
      return Response.json([
        voucher(VOUCHER, 'PENDING_APPROVAL', 'Free latte', {
          approval: { status: 'PENDING', submittedAt: '2026-11-20T00:00:00.000Z', reviewedAt: null, reason: null },
        }),
        voucher('66666666-6666-4666-8666-666666666666', 'ACTIVE', 'Cake day', { totalSupply: null }),
      ]);
    if (url === `${org}/vouchers/${VOUCHER}`)
      return Response.json(
        voucher(VOUCHER, 'DRAFT', 'Free latte', {
          approval: {
            status: 'REJECTED',
            submittedBy: { type: 'USER', id: 'user-2' },
            submittedAt: '2026-11-20T00:00:00.000Z',
            reviewedById: 'user-1',
            reviewedAt: '2026-11-21T00:00:00.000Z',
            reason: 'Points cost too low',
          },
        }),
      );
    if (url === `${org}/voucher-batches`)
      return Response.json([
        {
          id: BATCH,
          organizationId: ORG,
          name: 'catalog-11-11.csv',
          source: 'CONSOLE',
          createdBy: { type: 'USER', id: 'user-1' },
          createdAt: '2026-11-11T00:00:00.000Z',
          archivedAt: null,
          statusCounts: { DRAFT: 2, ACTIVE: 1 },
        },
      ]);
    if (url === `${org}/voucher-batches/${BATCH}`)
      return Response.json({
        id: BATCH,
        organizationId: ORG,
        name: 'catalog-11-11.csv',
        source: 'CONSOLE',
        createdBy: null,
        createdAt: '2026-11-11T00:00:00.000Z',
        archivedAt: null,
        statusCounts: { DRAFT: 1 },
        vouchers: [voucher(VOUCHER, 'DRAFT', 'Free latte')],
      });
    if (url === `${org}/budget`)
      return Response.json({
        organizationId: ORG,
        remaining: 1500,
        initialBudget: 10000,
        capacity: 10000,
        warningThreshold: 80,
        shards: [
          { shardId: 's1', remaining: 1000 },
          { shardId: 's2', remaining: 500 },
        ],
        recentTopUps: [{ operationId: 'op-1', amount: 5000, status: 'APPLIED', createdAt: '2026-10-01T00:00:00.000Z' }],
        observedAt: '2026-11-23T00:00:00.000Z',
      });
    if (url === `${org}/webhooks/endpoints`)
      return ownerOnly([
        {
          id: ENDPOINT,
          organizationId: ORG,
          url: 'https://shop.example/hooks?token=must-never-reach-the-model',
          description: 'Shop',
          status: 'ACTIVE',
          secret: 'whsec_must-never-reach-the-model',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ]);
    if (url === `${org}/webhooks/deliveries`)
      return ownerOnly([
        {
          id: 'd-1',
          endpointId: ENDPOINT,
          eventType: 'credits.earned',
          status: 'DEAD_LETTER',
          attemptCount: 8,
          nextAttemptAt: '2026-11-22T00:00:00.000Z',
          lastResponseStatus: 401,
          lastError: 'x'.repeat(1000),
          payload: { secret: 'must-never-reach-the-model' },
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
        { id: 'd-2', endpointId: ENDPOINT, eventType: 'credits.earned', status: 'DELIVERED', attemptCount: 1 },
      ]);
    if (url === `${org}/refund-policy/history?limit=1`)
      return ownerOnly([
        {
          version: 3,
          allowUnused: true,
          allowExpired: false,
          allowRedeemed: false,
          restockUnused: true,
          refundWindowDays: 7,
          reason: 'Shorter window',
          createdByUserId: 'user-1',
          createdAt: '2026-11-15T00:00:00.000Z',
        },
      ]);
    if (url === `${org}/staff`)
      return ownerOnly([
        {
          id: 'user-1',
          fullName: 'Test Owner',
          email: 'owner@example.test',
          persona: 'BUSINESS_OWNER',
          status: 'ACTIVE',
        },
      ]);
    if (url === `${org}/invitations`)
      return ownerOnly([
        {
          id: 'inv-1',
          email: 'dev@example.test',
          persona: 'BUSINESS_DEVELOPER',
          status: 'PENDING',
          expiresAt: '2026-11-30T00:00:00.000Z',
          token: 'invite-token-must-never-reach-the-model',
        },
      ]);
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
      'check_budget',
      'check_member_transactions',
      'check_webhooks',
      'find_customer',
      'review_api_keys',
      'review_console_access',
      'review_pending_vouchers',
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
      'find_customer',
      'review_api_keys',
      'summarize_member',
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

describe('read tools on existing console routes (OCT-294)', () => {
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const client = await connect(await handler(), token);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const structured = (outcome: Awaited<ReturnType<typeof call>>): Record<string, any> => {
    expect(outcome.isError).toBeFalsy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return outcome.structuredContent as Record<string, any>;
  };

  it('declares an output schema for every tool', async () => {
    fakeCore();
    const client = await connect(await handler(), GOOD);
    const tools = (await client.listTools()).tools;
    expect(tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name)).toEqual([]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it('finds a member by name and reads them with recent transactions and vouchers, never a serial', async () => {
    fakeCore();
    const found = structured(await call(GOOD, 'find_member', { query: 'Lan' }));
    expect(found).toEqual({
      members: [
        {
          memberId: MEMBER,
          displayName: 'Lan Nguyen',
          email: 'lan@example.test',
          phoneNumber: null,
          status: 'ACTIVE',
          posId: 'POS-77',
          joinedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      nextCursor: 'next-page',
    });

    const member = await call(GOOD, 'get_member', {
      memberId: MEMBER,
      include: ['transactions', 'vouchers'],
      limit: 2,
    });
    const detail = structured(member);
    expect(detail.member.posId).toBe('POS-77');
    expect(detail.balance.confirmedBalance).toBe(42);
    expect(detail.recentTransactions).toEqual([expect.objectContaining({ transactionId: 'tx-9', status: 'PENDING' })]);
    expect(detail.vouchers.map((v: { ownershipId: string }) => v.ownershipId)).toEqual(['own-1', 'own-2']);
    const text = JSON.stringify(member);
    expect(text).not.toContain('SERIAL-');
    expect(text).not.toContain('079123456789');

    const plain = structured(await call(GOOD, 'get_member', { memberId: MEMBER }));
    expect(plain.recentTransactions).toBeNull();
    expect(plain.vouchers).toBeNull();
  });

  it('filters the voucher catalog and reads one voucher with its rejection reason', async () => {
    fakeCore();
    const pending = structured(await call(DEVELOPER, 'list_vouchers', { status: 'PENDING_APPROVAL' }));
    expect(pending.matching).toBe(1);
    expect(pending.vouchers[0]).toMatchObject({
      voucherId: VOUCHER,
      title: 'Free latte',
      approvalStatus: 'PENDING',
      totalSupply: 100,
      remainingSupply: 60,
    });
    const cake = structured(await call(DEVELOPER, 'list_vouchers', { query: 'cake' }));
    expect(cake.vouchers).toEqual([expect.objectContaining({ title: 'Cake day', remainingSupply: null })]);

    const one = await call(DEVELOPER, 'get_voucher', { voucherId: VOUCHER });
    expect(structured(one).approval).toEqual({
      status: 'REJECTED',
      submittedAt: '2026-11-20T00:00:00.000Z',
      reviewedAt: '2026-11-21T00:00:00.000Z',
      reason: 'Points cost too low',
    });
    expect(JSON.stringify(one)).not.toContain('must-never-reach-the-model');
  });

  it('names what was not found', async () => {
    fakeCore();
    const missing = await call(GOOD, 'get_voucher', { voucherId: '77777777-7777-4777-8777-777777777777' });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('No voucher with this id');
  });

  it('reads batches, the budget and the organization without its tax or identity numbers', async () => {
    fakeCore();
    const batches = structured(await call(DEVELOPER, 'list_voucher_batches'));
    expect(batches.batches).toEqual([
      expect.objectContaining({ batchId: BATCH, name: 'catalog-11-11.csv', statusCounts: { DRAFT: 2, ACTIVE: 1 } }),
    ]);
    const batch = structured(await call(DEVELOPER, 'get_voucher_batch', { batchId: BATCH }));
    expect(batch.vouchers).toEqual([expect.objectContaining({ voucherId: VOUCHER, status: 'DRAFT' })]);

    const budget = structured(await call(DEVELOPER, 'get_budget'));
    expect(budget).toMatchObject({ remaining: 1500, usedPercent: 85, warningThreshold: 80, lowestShardRemaining: 500 });

    const organization = await call(DEVELOPER, 'get_organization');
    expect(structured(organization)).toMatchObject({ name: 'Coffee', voucherApprovalRequired: true });
    const text = JSON.stringify(organization);
    expect(text).not.toContain('TAX-must-never-reach-the-model');
    expect(text).not.toContain('6789');
  });

  it("explains an Owner's webhook failures without secrets, tokens or the payload", async () => {
    fakeCore();
    const endpoints = await call(GOOD, 'list_webhook_endpoints');
    expect(structured(endpoints).endpoints).toEqual([
      expect.objectContaining({ endpointId: ENDPOINT, url: 'https://shop.example/hooks', status: 'ACTIVE' }),
    ]);
    const deliveries = await call(GOOD, 'list_webhook_deliveries', { status: 'DEAD_LETTER' });
    const failed = structured(deliveries);
    expect(failed.matching).toBe(1);
    expect(failed.deliveries[0]).toMatchObject({ deliveryId: 'd-1', lastResponseStatus: 401, attemptCount: 8 });
    expect(failed.deliveries[0].lastError).toHaveLength(300);
    for (const outcome of [endpoints, deliveries]) {
      expect(JSON.stringify(outcome)).not.toContain('must-never-reach-the-model');
    }
  });

  it("reads an Owner's refund-policy history, staff and invitations, never an invitation token", async () => {
    fakeCore();
    const history = structured(await call(GOOD, 'get_refund_policy_history', { limit: 1 }));
    expect(history).toEqual({
      versions: [expect.objectContaining({ version: 3, refundWindowDays: 7, reason: 'Shorter window' })],
      nextBeforeVersion: 3,
    });
    expect(structured(await call(GOOD, 'list_staff')).staff).toEqual([
      expect.objectContaining({ fullName: 'Test Owner', persona: 'BUSINESS_OWNER' }),
    ]);
    const invitations = await call(GOOD, 'list_invitations');
    expect(structured(invitations).invitations).toEqual([
      expect.objectContaining({ email: 'dev@example.test', status: 'PENDING' }),
    ]);
    expect(JSON.stringify(invitations)).not.toContain('invite-token');
  });

  it('still gets Core 403 when a wrong map gives a Developer the Owner-only webhook deliveries', async () => {
    fakeCore();
    const server = createServer({
      tools: ['list_webhook_deliveries', 'list_staff'],
      client: consoleCoreClient(CORE, DEVELOPER, ORG),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const name of ['list_webhook_deliveries', 'list_staff']) {
      const outcome = await client.callTool({ name, arguments: {} });
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.content)).toContain('Core denied this read');
      expect(JSON.stringify(outcome.content)).not.toContain('credits.earned');
    }
    await client.close();
    await server.close();
  });
});
