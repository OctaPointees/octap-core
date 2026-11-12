import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo } from '@modelcontextprotocol/server';
import { OctaApiError } from '@octap/sdk';
import {
  createServer,
  coreClient,
  safeError,
  isOctaApiError,
  type CoreClientLike,
  type CreateServerOptions,
} from '../src/server.js';

describe('Octap MCP Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function createTestHarness(options: CreateServerOptions = {}, authInfo?: AuthInfo) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    if (authInfo) {
      const send = clientTransport.send.bind(clientTransport);
      clientTransport.send = (message, sendOptions) => send(message, { ...sendOptions, authInfo });
    }
    const server = createServer(options);
    const client = new Client({ name: 'test-mcp-client', version: '1.0.0' }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return {
      client,
      server,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  describe('coreClient configuration', () => {
    it('throws when OCTAP_API_KEY is missing or empty', () => {
      delete process.env.OCTAP_API_KEY;
      expect(() => coreClient()).toThrow('OCTAP_API_KEY is required');

      process.env.OCTAP_API_KEY = '   ';
      expect(() => coreClient()).toThrow('OCTAP_API_KEY is required');
    });

    it('throws when OCTAP_API_URL is missing or invalid', () => {
      process.env.OCTAP_API_KEY = 'test-key';
      delete process.env.OCTAP_API_URL;
      expect(() => coreClient()).toThrow('OCTAP_API_URL is required');

      process.env.OCTAP_API_URL = 'not-a-valid-url';
      expect(() => coreClient()).toThrow('OCTAP_API_URL must be an absolute HTTP(S) URL');

      process.env.OCTAP_API_URL = 'ftp://localhost:3000';
      expect(() => coreClient()).toThrow('OCTAP_API_URL must use HTTP or HTTPS');
    });

    it('creates OctaPointClient with trimmed standard env vars', () => {
      process.env.OCTAP_API_KEY = ' test-key ';
      process.env.OCTAP_API_URL = ' http://127.0.0.1:3000/ ';
      const client = coreClient();
      expect(client).toBeDefined();
    });

    it('ignores legacy OCTAP_CORE_* env vars', () => {
      delete process.env.OCTAP_API_KEY;
      delete process.env.OCTAP_API_URL;
      process.env.OCTAP_CORE_API_KEY = 'legacy-key';
      process.env.OCTAP_CORE_API_URL = 'http://127.0.0.1:3000';
      expect(() => coreClient()).toThrow('OCTAP_API_KEY is required');
    });
  });

  describe('error checking and safeError mapping', () => {
    it('isOctaApiError checks structurally as well as by instanceof', () => {
      const realError = new OctaApiError(404, 'Not Found', {});
      expect(isOctaApiError(realError)).toBe(true);

      const duckTypedError = {
        name: 'OctaApiError',
        statusCode: 403,
        message: 'Forbidden',
      };
      expect(isOctaApiError(duckTypedError)).toBe(true);

      expect(isOctaApiError(new Error('general error'))).toBe(false);
      expect(isOctaApiError(null)).toBe(false);
      expect(isOctaApiError(undefined)).toBe(false);
      expect(isOctaApiError({ statusCode: 'not-a-number', name: 'OctaApiError' })).toBe(false);
    });

    it('maps 401 and 403 to permission denial message', () => {
      const res401 = safeError('test_tool', new OctaApiError(401, 'Unauthorized', {}));
      expect(res401.isError).toBe(true);
      expect(res401.content[0].text).toContain('Core denied this read');

      const res403 = safeError('test_tool', { name: 'OctaApiError', statusCode: 403 });
      expect(res403.content[0].text).toContain('Core denied this read');
    });

    it('maps 404 to not found message', () => {
      const res = safeError('test_tool', new OctaApiError(404, 'Not Found', {}));
      expect(res.content[0].text).toContain('No matching member or resource was found');
    });

    it('maps 429 to rate limit message advising not to retry this turn', () => {
      const res = safeError('test_tool', new OctaApiError(429, 'Too Many Requests', {}));
      expect(res.content[0].text).toBe('Rate limited; do not retry this call in this turn.');
    });

    it('maps 500+ to temporary unavailability message advising not to retry this turn', () => {
      const res500 = safeError('test_tool', new OctaApiError(500, 'Internal Server Error', {}));
      expect(res500.content[0].text).toBe('Core is temporarily unavailable; do not retry this call in this turn.');

      const res503 = safeError('test_tool', { name: 'OctaApiError', statusCode: 503 });
      expect(res503.content[0].text).toBe('Core is temporarily unavailable; do not retry this call in this turn.');
    });

    it('maps other client status codes to general input rejection message', () => {
      const res = safeError('test_tool', new OctaApiError(400, 'Bad Request', {}));
      expect(res.content[0].text).toBe('Core rejected this request. Check the member ID and tool inputs.');
    });

    it('sanitizes unexpected errors without leaking stack or internal details', () => {
      const res = safeError('test_tool', new Error('DB connection refused on internal.cluster.local:5432'));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe('Core could not complete this read. Check the local server logs.');
      expect(res.content[0].text).not.toContain('internal.cluster.local');
    });
  });

  describe('protocol-level tool discovery (client.listTools)', () => {
    const dummyClient: CoreClientLike = {
      getBalance: vi.fn(),
      listTransactions: vi.fn(),
      listMemberVouchers: vi.fn(),
    };

    it('discovers all three read-only tools by default', async () => {
      const harness = await createTestHarness({ client: dummyClient });
      try {
        const response = await harness.client.listTools();
        const toolNames = response.tools.map((t) => t.name).sort();

        expect(toolNames).toEqual(['get_member_balance', 'list_member_transactions', 'list_member_vouchers']);

        for (const tool of response.tools) {
          expect(tool.annotations?.readOnlyHint).toBe(true);
        }
      } finally {
        await harness.close();
      }
    });

    it('respects tools allowlist option', async () => {
      const harness = await createTestHarness({
        client: dummyClient,
        tools: ['get_member_balance'],
      });
      try {
        const response = await harness.client.listTools();
        expect(response.tools).toHaveLength(1);
        expect(response.tools[0].name).toBe('get_member_balance');
      } finally {
        await harness.close();
      }
    });

    it('omits memberId from tool input schema when resolveMemberId is provided', async () => {
      const harness = await createTestHarness({
        client: dummyClient,
        resolveMemberId: () => '123e4567-e89b-12d3-a456-426614174000',
      });
      try {
        const response = await harness.client.listTools();
        const balanceTool = response.tools.find((t) => t.name === 'get_member_balance')!;
        expect(balanceTool.inputSchema.properties?.memberId).toBeUndefined();

        const txTool = response.tools.find((t) => t.name === 'list_member_transactions')!;
        expect(txTool.inputSchema.properties?.memberId).toBeUndefined();
        expect(txTool.inputSchema.properties?.limit).toBeDefined();
      } finally {
        await harness.close();
      }
    });
  });

  describe('protocol-level tool invocations (client.callTool)', () => {
    const memberId = '123e4567-e89b-12d3-a456-426614174000';

    it('executes get_member_balance and formats confirmed and pending balances', async () => {
      const mockBalance = {
        organizationEndUserId: memberId,
        confirmedBalance: 250,
        pendingEarn: 25,
        pendingRedemption: 10,
        lifetimeEarned: 500,
        lifetimeRedeemed: 225,
        asOfCheckpoint: '10042',
        observedAt: '2026-11-12T12:00:00Z',
        stale: false,
      };

      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockResolvedValue(mockBalance),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: { memberId },
        });

        expect(mockClient.getBalance).toHaveBeenCalledWith(memberId, expect.any(Object));
        expect(res.isError).toBeFalsy();

        const content = res.content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text);
        expect(data).toEqual({
          memberId,
          confirmedBalance: 250,
          pendingEarn: 25,
          pendingRedemption: 10,
          lifetimeEarned: 500,
          lifetimeRedeemed: 225,
          asOfCheckpoint: '10042',
          observedAt: '2026-11-12T12:00:00Z',
          stale: false,
        });
      } finally {
        await harness.close();
      }
    });

    it('rejects malformed memberId via protocol schema validation', async () => {
      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: { memberId: 'not-a-valid-uuid' },
        });

        expect(res.isError).toBe(true);
        const content = res.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toContain('Invalid UUID');
        expect(mockClient.getBalance).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    });

    it('rejects model-supplied extra arguments via strict schema validation', async () => {
      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: { memberId, tenantId: 'forbidden-tenant' },
        });

        expect(res.isError).toBe(true);
        expect(mockClient.getBalance).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    });

    it('returns standard not-found error for cross-tenant member lookups (no existence oracle)', async () => {
      const crossTenantMemberId = '99999999-9999-4999-8999-999999999999';
      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockRejectedValue(new OctaApiError(404, 'Not Found', {})),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: { memberId: crossTenantMemberId },
        });

        expect(res.isError).toBe(true);
        const content = res.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe('No matching member or resource was found in the configured organization.');
      } finally {
        await harness.close();
      }
    });

    it('executes list_member_transactions with bounded limits and strips internal metadata', async () => {
      const mockRows = [
        {
          id: 'tx-1',
          organizationId: 'secret-org-id',
          organizationEndUserId: memberId,
          transactionType: 'EARN',
          status: 'CONFIRMED',
          pointsAmount: 50,
          estimatedPoints: 50,
          purchaseAmount: '10.00',
          blockchainDigest: '0xdigest',
          createdAt: '2026-11-12T10:00:00Z',
          updatedAt: '2026-11-12T10:01:00Z',
          metadata: { privateInternalData: true },
        },
      ];

      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn().mockResolvedValue(mockRows),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'list_member_transactions',
          arguments: { memberId, limit: 10 },
        });

        expect(mockClient.listTransactions).toHaveBeenCalledWith(memberId, expect.objectContaining({ limit: 10 }));
        expect(res.isError).toBeFalsy();

        const content = res.content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text);
        expect(data).toHaveLength(1);
        expect(data[0]).toEqual({
          transactionId: 'tx-1',
          type: 'EARN',
          status: 'CONFIRMED',
          pointsAmount: 50,
          estimatedPoints: 50,
          purchaseAmount: '10.00',
          blockchainDigest: '0xdigest',
          createdAt: '2026-11-12T10:00:00Z',
          updatedAt: '2026-11-12T10:01:00Z',
        });
        expect(data[0].organizationId).toBeUndefined();
        expect(data[0].metadata).toBeUndefined();
      } finally {
        await harness.close();
      }
    });

    it('rejects invalid limit bounds for list_member_transactions', async () => {
      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const resZero = await harness.client.callTool({
          name: 'list_member_transactions',
          arguments: { memberId, limit: 0 },
        });
        expect(resZero.isError).toBe(true);

        const resOverMax = await harness.client.callTool({
          name: 'list_member_transactions',
          arguments: { memberId, limit: 51 },
        });
        expect(resOverMax.isError).toBe(true);
      } finally {
        await harness.close();
      }
    });

    it('executes list_member_vouchers and omits serial codes', async () => {
      const mockVouchers = [
        {
          id: 'own-1',
          voucherId: 'v-100',
          serialCode: 'CONFIDENTIAL-SERIAL-CODE',
          status: 'CLAIMED',
          claimedAt: '2026-11-10T08:00:00Z',
          redeemedAt: null,
          expiresAt: '2026-12-10T08:00:00Z',
          voucher: { title: 'Free Coffee' },
        },
      ];

      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn().mockResolvedValue(mockVouchers),
      };

      const harness = await createTestHarness({ client: mockClient });
      try {
        const res = await harness.client.callTool({
          name: 'list_member_vouchers',
          arguments: { memberId, limit: 5 },
        });

        expect(res.isError).toBeFalsy();
        const content = res.content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text);
        expect(data).toHaveLength(1);
        expect(data[0]).toEqual({
          ownershipId: 'own-1',
          voucherId: 'v-100',
          status: 'CLAIMED',
          claimedAt: '2026-11-10T08:00:00Z',
          redeemedAt: null,
          expiresAt: '2026-12-10T08:00:00Z',
          title: 'Free Coffee',
        });
        expect(content[0].text).not.toContain('CONFIDENTIAL-SERIAL-CODE');
      } finally {
        await harness.close();
      }
    });

    it('supports resolveMemberId binding for chatbot embedding', async () => {
      const boundMemberId = '77777777-7777-4777-8777-777777777777';
      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockResolvedValue({
          organizationEndUserId: boundMemberId,
          confirmedBalance: 88,
          pendingEarn: 0,
          pendingRedemption: 0,
          lifetimeEarned: 88,
          lifetimeRedeemed: 0,
          asOfCheckpoint: '10',
          observedAt: '2026-11-12T12:00:00Z',
          stale: false,
        }),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const resolveMemberId = vi.fn((context) => context.http?.authInfo?.extra?.memberId as string);
      const authInfo: AuthInfo = {
        token: 'validated-test-token',
        clientId: 'customer-chat-host',
        scopes: ['member:read'],
        extra: { memberId: boundMemberId },
      };
      const harness = await createTestHarness(
        {
          client: mockClient,
          resolveMemberId,
        },
        authInfo,
      );
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: {},
        });

        expect(mockClient.getBalance).toHaveBeenCalledWith(boundMemberId, expect.any(Object));
        expect(resolveMemberId).toHaveBeenCalledWith(
          expect.objectContaining({ http: expect.objectContaining({ authInfo }) }),
        );
        expect(res.isError).toBeFalsy();
      } finally {
        await harness.close();
      }
    });

    it('aborts the Core request when the MCP client cancels a tool call', async () => {
      let coreSignal: AbortSignal | undefined;
      const mockClient: CoreClientLike = {
        getBalance: vi.fn((_memberId, options) => {
          coreSignal = options?.signal;
          return new Promise<never>((_resolve, reject) => {
            coreSignal?.addEventListener('abort', () => reject(new Error('Core request aborted')), { once: true });
          });
        }),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };
      const harness = await createTestHarness({ client: mockClient });
      const controller = new AbortController();
      try {
        const call = harness.client.callTool(
          { name: 'get_member_balance', arguments: { memberId } },
          { signal: controller.signal },
        );
        await vi.waitFor(() => expect(mockClient.getBalance).toHaveBeenCalledOnce());
        controller.abort(new Error('host cancelled request'));
        await expect(call).rejects.toThrow();
        expect(coreSignal?.aborted).toBe(true);
      } finally {
        await harness.close();
      }
    });

    it.each([undefined, 'not-a-uuid'])('fails closed when resolveMemberId returns %s', async (resolvedMemberId) => {
      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({
        client: mockClient,
        resolveMemberId: () => resolvedMemberId,
      });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: {},
        });

        expect(res.isError).toBe(true);
        const content = res.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe('No authenticated member is bound to this request.');
        expect(mockClient.getBalance).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    });

    it('supports project hook for output transformation', async () => {
      const mockBalance = {
        organizationEndUserId: memberId,
        confirmedBalance: 100,
        pendingEarn: 0,
        pendingRedemption: 0,
        lifetimeEarned: 100,
        lifetimeRedeemed: 0,
        asOfCheckpoint: '10',
        observedAt: '2026-11-12T12:00:00Z',
        stale: false,
      };

      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockResolvedValue(mockBalance),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const harness = await createTestHarness({
        client: mockClient,
        project: (_tool, val) => ({
          ...(val as Record<string, unknown>),
          projected: true,
        }),
      });
      try {
        const res = await harness.client.callTool({
          name: 'get_member_balance',
          arguments: { memberId },
        });

        const content = res.content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text);
        expect(data.projected).toBe(true);
      } finally {
        await harness.close();
      }
    });
  });
});
