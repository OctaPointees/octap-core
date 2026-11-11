import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OctaApiError } from '@octap/sdk';
import { createServer, coreClient, safeError, DEFAULT_LIMIT, MAX_LIMIT, type CoreClientLike } from '../src/server.js';

describe('MCP Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('coreClient configuration', () => {
    it('throws when OCTAP_CORE_API_KEY is missing or empty', () => {
      delete process.env.OCTAP_CORE_API_KEY;
      expect(() => coreClient()).toThrow('OCTAP_CORE_API_KEY is required');

      process.env.OCTAP_CORE_API_KEY = '   ';
      expect(() => coreClient()).toThrow('OCTAP_CORE_API_KEY is required');
    });

    it('throws when OCTAP_CORE_API_URL is invalid', () => {
      process.env.OCTAP_CORE_API_KEY = 'test-key';
      process.env.OCTAP_CORE_API_URL = 'not-a-valid-url';
      expect(() => coreClient()).toThrow('OCTAP_CORE_API_URL must be an absolute HTTP(S) URL');

      process.env.OCTAP_CORE_API_URL = 'ftp://localhost:3000';
      expect(() => coreClient()).toThrow('OCTAP_CORE_API_URL must use HTTP or HTTPS');
    });

    it('creates OctaPointClient with trimmed defaults', () => {
      process.env.OCTAP_CORE_API_KEY = ' test-key ';
      process.env.OCTAP_CORE_API_URL = ' http://127.0.0.1:3000/ ';
      const client = coreClient();
      expect(client).toBeDefined();
    });
  });

  describe('safeError mapping', () => {
    it('maps 401 and 403 to permission denial message', () => {
      const err401 = new OctaApiError(401, 'Unauthorized', { message: 'secret leak' });
      const res401 = safeError('test_tool', err401);
      expect(res401.isError).toBe(true);
      expect(res401.content[0].text).toContain('Core denied this read');

      const err403 = new OctaApiError(403, 'Forbidden', {});
      const res403 = safeError('test_tool', err403);
      expect(res403.content[0].text).toContain('Core denied this read');
    });

    it('maps 404 to not found message', () => {
      const err = new OctaApiError(404, 'Not Found', {});
      const res = safeError('test_tool', err);
      expect(res.content[0].text).toContain('No matching member or resource was found');
    });

    it('maps 429 to rate limit message', () => {
      const err = new OctaApiError(429, 'Too Many Requests', {});
      const res = safeError('test_tool', err);
      expect(res.content[0].text).toContain('Core rate limited this request');
    });

    it('maps 500+ to temporary unavailability message', () => {
      const err500 = new OctaApiError(500, 'Internal Server Error', {});
      const res500 = safeError('test_tool', err500);
      expect(res500.content[0].text).toContain('Core is temporarily unavailable');

      const err503 = new OctaApiError(503, 'Service Unavailable', {});
      const res503 = safeError('test_tool', err503);
      expect(res503.content[0].text).toContain('Core is temporarily unavailable');
    });

    it('maps other status codes to general input rejection message', () => {
      const err = new OctaApiError(400, 'Bad Request', {});
      const res = safeError('test_tool', err);
      expect(res.content[0].text).toContain('Core rejected this request');
    });

    it('sanitizes unexpected/network errors without leaking internal error details', () => {
      const res = safeError('test_tool', new Error('database connection timeout at secret-host:5432'));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe('Core could not complete this read. Check the local server logs.');
      expect(res.content[0].text).not.toContain('secret-host');
    });
  });

  describe('tool schemas and read-only annotations', () => {
    const dummyClient: CoreClientLike = {
      getBalance: vi.fn(),
      listTransactions: vi.fn(),
      listMemberVouchers: vi.fn(),
    };

    it('registers exactly three read-only tools', () => {
      const server = createServer(dummyClient);
      const registeredTools = (server as any)._registeredTools;
      const toolNames = Object.keys(registeredTools).sort();

      expect(toolNames).toEqual(['get_member_balance', 'list_member_transactions', 'list_member_vouchers']);

      for (const name of toolNames) {
        expect(registeredTools[name].annotations?.readOnlyHint).toBe(true);
      }
    });

    it('validates get_member_balance schema strictly', () => {
      const server = createServer(dummyClient);
      const schema = (server as any)._registeredTools['get_member_balance'].inputSchema;

      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
      expect(schema.safeParse({ memberId: 'not-a-uuid' }).success).toBe(false);
      expect(
        schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', tenantId: 'forbidden' }).success,
      ).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });

    it('validates list_member_transactions limit defaults and bounds', () => {
      const server = createServer(dummyClient);
      const schema = (server as any)._registeredTools['list_member_transactions'].inputSchema;

      const parsedDefault = schema.parse({ memberId: '123e4567-e89b-12d3-a456-426614174000' });
      expect(parsedDefault.limit).toBe(DEFAULT_LIMIT);

      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 1 }).success).toBe(true);
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: MAX_LIMIT }).success).toBe(
        true,
      );
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 51 }).success).toBe(false);
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 1.5 }).success).toBe(false);
    });

    it('validates list_member_vouchers limit defaults and bounds', () => {
      const server = createServer(dummyClient);
      const schema = (server as any)._registeredTools['list_member_vouchers'].inputSchema;

      const parsedDefault = schema.parse({ memberId: '123e4567-e89b-12d3-a456-426614174000' });
      expect(parsedDefault.limit).toBe(DEFAULT_LIMIT);

      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 10 }).success).toBe(true);
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ memberId: '123e4567-e89b-12d3-a456-426614174000', limit: 100 }).success).toBe(false);
    });
  });

  describe('tool executions and response shaping', () => {
    it('executes get_member_balance and formats response payload', async () => {
      const memberId = '123e4567-e89b-12d3-a456-426614174000';
      const mockBalance = {
        organizationEndUserId: memberId,
        confirmedBalance: 250,
        pendingEarn: 25,
        pendingRedemption: 10,
        lifetimeEarned: 500,
        lifetimeRedeemed: 225,
        asOfCheckpoint: '10042',
        observedAt: '2026-11-11T12:00:00Z',
        stale: false,
      };

      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockResolvedValue(mockBalance),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const server = createServer(mockClient);
      const handler = (server as any)._registeredTools['get_member_balance'].handler;

      const response = await handler({ memberId });
      expect(mockClient.getBalance).toHaveBeenCalledWith(memberId, expect.any(Object));

      expect(response.isError).toBeUndefined();
      const data = JSON.parse(response.content[0].text);
      expect(data).toEqual({
        memberId,
        confirmedBalance: 250,
        pendingEarn: 25,
        pendingRedemption: 10,
        lifetimeEarned: 500,
        lifetimeRedeemed: 225,
        asOfCheckpoint: '10042',
        observedAt: '2026-11-11T12:00:00Z',
        stale: false,
      });
    });

    it('returns safe error when get_member_balance throws', async () => {
      const mockClient: CoreClientLike = {
        getBalance: vi.fn().mockRejectedValue(new OctaApiError(404, 'Not Found', {})),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn(),
      };

      const server = createServer(mockClient);
      const handler = (server as any)._registeredTools['get_member_balance'].handler;

      const response = await handler({ memberId: '123e4567-e89b-12d3-a456-426614174000' });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('No matching member or resource was found');
    });

    it('executes list_member_transactions and strips unnecessary internal fields', async () => {
      const memberId = '123e4567-e89b-12d3-a456-426614174000';
      const mockRows = [
        {
          id: 'tx-1',
          organizationId: 'org-internal',
          organizationEndUserId: memberId,
          transactionType: 'EARN',
          status: 'CONFIRMED',
          pointsAmount: 50,
          estimatedPoints: 50,
          purchaseAmount: '10.00',
          blockchainDigest: '0xdigest1',
          createdAt: '2026-11-10T10:00:00Z',
          updatedAt: '2026-11-10T10:01:00Z',
          metadata: { internalSecret: 'hide-me' },
        },
      ];

      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn().mockResolvedValue(mockRows),
        listMemberVouchers: vi.fn(),
      };

      const server = createServer(mockClient);
      const handler = (server as any)._registeredTools['list_member_transactions'].handler;

      const response = await handler({ memberId, limit: 10 });
      expect(mockClient.listTransactions).toHaveBeenCalledWith(memberId, expect.objectContaining({ limit: 10 }));

      const data = JSON.parse(response.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0]).toEqual({
        transactionId: 'tx-1',
        type: 'EARN',
        status: 'CONFIRMED',
        pointsAmount: 50,
        estimatedPoints: 50,
        purchaseAmount: '10.00',
        blockchainDigest: '0xdigest1',
        createdAt: '2026-11-10T10:00:00Z',
        updatedAt: '2026-11-10T10:01:00Z',
      });
      // Verifies internal fields are excluded
      expect(data[0].metadata).toBeUndefined();
      expect(data[0].organizationId).toBeUndefined();
    });

    it('executes list_member_vouchers and omits serial codes', async () => {
      const memberId = '123e4567-e89b-12d3-a456-426614174000';
      const mockVouchers = [
        {
          id: 'own-1',
          voucherId: 'v-100',
          serialCode: 'SECRET-VOUCHER-CODE-1234',
          status: 'CLAIMED',
          claimedAt: '2026-11-09T08:00:00Z',
          redeemedAt: null,
          expiresAt: '2026-12-09T08:00:00Z',
          voucher: {
            title: '10% Discount on Coffee',
          },
        },
        {
          id: 'own-2',
          voucherId: 'v-101',
          serialCode: 'SECRET-VOUCHER-CODE-5678',
          status: 'REDEEMED',
          claimedAt: '2026-11-08T08:00:00Z',
          redeemedAt: '2026-11-09T09:00:00Z',
          expiresAt: '2026-12-08T08:00:00Z',
          voucher: {
            title: 'Free Pastry',
          },
        },
      ];

      const mockClient: CoreClientLike = {
        getBalance: vi.fn(),
        listTransactions: vi.fn(),
        listMemberVouchers: vi.fn().mockResolvedValue(mockVouchers),
      };

      const server = createServer(mockClient);
      const handler = (server as any)._registeredTools['list_member_vouchers'].handler;

      const response = await handler({ memberId, limit: 1 });
      const data = JSON.parse(response.content[0].text);

      // Verify slicing to limit
      expect(data).toHaveLength(1);
      expect(data[0]).toEqual({
        ownershipId: 'own-1',
        voucherId: 'v-100',
        status: 'CLAIMED',
        claimedAt: '2026-11-09T08:00:00Z',
        redeemedAt: null,
        expiresAt: '2026-12-09T08:00:00Z',
        title: '10% Discount on Coffee',
      });
      // Verify serial code is omitted
      expect((data[0] as any).serialCode).toBeUndefined();
      expect(response.content[0].text).not.toContain('SECRET-VOUCHER-CODE');
    });
  });
});
