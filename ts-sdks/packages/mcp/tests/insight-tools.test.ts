import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { OctaApiError } from '@octap/sdk';
import type { InsightReads } from '../src/insight-tools.js';
import { toolsForPersona } from '../src/personas.js';
import { createServer, type CoreClientLike } from '../src/server.js';

const STATS = {
  requests: 10,
  succeeded: 8,
  clientErrors: 2,
  serverErrors: 0,
  errorRate: 0.2,
  latencyMs: { p50: 40, p95: 90, p99: null },
};
const KEY = { id: 'key-1', name: 'POS', keyPrefix: 'octap_live_ab12' };
const LOG = {
  requestId: 'req-1',
  method: 'POST',
  route: '/v1/credits/earn',
  path: '/v1/credits/earn',
  statusCode: 409,
  latencyMs: 31,
  category: 'credits',
  errorCode: 'IDEMPOTENCY_CONFLICT',
  errorMessage: 'This idempotency key was used for another request',
  credential: KEY,
  userAgent: '@octap/sdk 0.3.0',
  createdAt: '2026-11-27T10:42:00.000Z',
  // Left out by the tool: the full error body.
  errorBody: { secretish: 'never shown' },
};

function fakeCore(overrides: Partial<InsightReads> = {}) {
  const reads: InsightReads = {
    consoleTransactions: vi.fn(async () => ({
      items: [
        {
          id: 'tx-1',
          organizationEndUserId: 'member-1',
          transactionType: 'REDEEM',
          status: 'PENDING',
          pointsAmount: null,
          estimatedPoints: '200',
          createdAt: '2026-11-27T00:00:00.000Z',
          internalNote: 'not whitelisted',
        },
      ] as never,
      nextCursor: 'next',
    })),
    getProgramAnalytics: vi.fn(async () => ({
      from: '2026-11-20T00:00:00.000Z',
      to: '2026-11-27T00:00:00.000Z',
      circulation: { earned: 5000, redeemed: 1200, reversed: 0, net: 3800, extra: 1 } as never,
      engagement: { activeMembers: 40, enrolledMembers: 120 },
      vouchers: { claimed: 30, redeemed: 18, expiredUnused: 2 },
      dailyTrend: [{ start: '2026-11-26T00:00:00.000Z', earned: 700, redeemed: 100 }],
    })),
    searchRequestLogs: vi.fn(async () => ({ items: [LOG], page: 1, limit: 20, total: 1 })),
    getRequestLog: vi.fn(async () => LOG),
    getApiErrors: vi.fn(async () => [
      {
        method: 'POST',
        route: '/v1/credits/earn',
        statusCode: 409,
        errorCode: 'IDEMPOTENCY_CONFLICT',
        errorMessage: 'reused',
        count: 7,
        firstSeenAt: '2026-11-27T08:00:00.000Z',
        lastSeenAt: '2026-11-27T10:42:00.000Z',
        lastRequestId: 'req-1',
      },
    ]),
    getApiUsage: vi.fn(async () => ({
      from: 'a',
      to: 'b',
      totals: STATS,
      byCategory: [{ category: 'credits', ...STATS }],
      byRoute: [{ method: 'POST', route: '/v1/credits/earn', ...STATS }],
      byCredential: [
        { credential: KEY, ...STATS },
        { credential: null, ...STATS, latencyMs: null },
      ],
    })),
    ...overrides,
  };
  const client = {
    getBalance: vi.fn(),
    listTransactions: vi.fn(),
    listMemberVouchers: vi.fn(),
    ...reads,
  } as unknown as CoreClientLike;
  return { client, reads };
}

async function connect(client: CoreClientLike, persona = 'BUSINESS_DEVELOPER') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ client, tools: toolsForPersona(persona) });
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

describe('MCP insight tools (OCT-314 part 2)', () => {
  it("lists the organization's transactions with whitelisted fields, passing the filters on", async () => {
    const { client, reads } = fakeCore();
    const mcp = await connect(client);
    const answer = await mcp.callTool({ name: 'list_transactions', arguments: { type: 'REDEEM', status: 'PENDING' } });
    expect(answer.structuredContent).toEqual({
      transactions: [
        {
          transactionId: 'tx-1',
          memberId: 'member-1',
          type: 'REDEEM',
          status: 'PENDING',
          pointsAmount: null,
          estimatedPoints: '200',
          purchaseAmount: null,
          blockchainDigest: null,
          createdAt: '2026-11-27T00:00:00.000Z',
          updatedAt: null,
        },
      ],
      nextCursor: 'next',
    });
    expect(reads.consoleTransactions).toHaveBeenCalledWith(
      { type: 'REDEEM', status: 'PENDING', limit: 20 },
      expect.anything(),
    );
  });

  it('summarizes the program over a period, without fields Core adds later', async () => {
    const { client, reads } = fakeCore();
    const mcp = await connect(client);
    const answer = await mcp.callTool({
      name: 'get_program_analytics',
      arguments: { from: '2026-11-20T00:00:00+07:00' },
    });
    expect(answer.structuredContent).toMatchObject({
      circulation: { earned: 5000, redeemed: 1200, reversed: 0, net: 3800 },
      engagement: { activeMembers: 40, enrolledMembers: 120 },
      dailyTrend: [{ earned: 700, redeemed: 100 }],
    });
    expect(JSON.stringify(answer.structuredContent)).not.toContain('extra');
    expect(reads.getProgramAnalytics).toHaveBeenCalledWith({ from: '2026-11-20T00:00:00+07:00' }, expect.anything());
  });

  it('searches and reads API calls without their error body, naming the key by name and prefix', async () => {
    const { client, reads } = fakeCore();
    const mcp = await connect(client);
    const page = await mcp.callTool({
      name: 'search_request_logs',
      arguments: { status: 'failed', route: '/v1/credits/earn' },
    });
    expect(page.structuredContent).toMatchObject({
      total: 1,
      requests: [{ requestId: 'req-1', statusCode: 409, apiKey: { name: 'POS', keyPrefix: 'octap_live_ab12' } }],
    });
    expect(reads.searchRequestLogs).toHaveBeenCalledWith(
      { status: 'failed', route: '/v1/credits/earn', page: 1, limit: 20 },
      expect.anything(),
    );
    const one = await mcp.callTool({ name: 'get_request_log', arguments: { requestId: 'req-1' } });
    expect(one.structuredContent).toMatchObject({ errorCode: 'IDEMPOTENCY_CONFLICT', userAgent: '@octap/sdk 0.3.0' });
    expect(JSON.stringify(one.content)).not.toContain('never shown');
    expect(JSON.stringify(one.content)).not.toContain('key-1');

    const bad = await mcp.callTool({ name: 'search_request_logs', arguments: { status: 'oops' } });
    expect(bad.isError).toBe(true);
  });

  it('groups API errors and reports usage per category, route and key', async () => {
    const { client } = fakeCore();
    const mcp = await connect(client);
    const errors = await mcp.callTool({ name: 'get_api_errors', arguments: {} });
    expect(errors.structuredContent).toMatchObject({ errors: [{ count: 7, lastRequestId: 'req-1' }] });
    const usage = await mcp.callTool({ name: 'get_api_usage', arguments: { category: 'credits' } });
    expect(usage.structuredContent).toMatchObject({
      totals: { requests: 10, errorRate: 0.2, latencyMs: { p50: 40, p95: 90, p99: null } },
      byCategory: [{ category: 'credits' }],
      byRoute: [{ route: '/v1/credits/earn' }],
      byApiKey: [{ apiKey: { name: 'POS' } }, { apiKey: null, latencyMs: null }],
    });
  });

  it('says when a request id is unknown, and offers none of these over an API key', async () => {
    const { client } = fakeCore({
      getRequestLog: vi.fn(async () => {
        throw new OctaApiError(404, 'Not Found', null);
      }),
    });
    const mcp = await connect(client);
    const missing = await mcp.callTool({ name: 'get_request_log', arguments: { requestId: 'nope' } });
    expect(JSON.stringify(missing.content)).toContain('No API call with this request id');

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const stdio = createServer({
      client: {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      } as unknown as CoreClientLike,
    });
    const api = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await stdio.connect(serverTransport);
    await api.connect(clientTransport);
    expect((await api.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'get_member_balance',
      'list_member_transactions',
      'list_member_vouchers',
    ]);
  });
});
