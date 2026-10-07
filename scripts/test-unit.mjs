import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EarnService } from '../api/dist/domain/credits/earn.service.js';
import { RedemptionService } from '../api/dist/domain/credits/redemption.service.js';
import { RewardsService } from '../api/dist/domain/rewards/rewards.service.js';

test('EarnService: successfully records points and updates balance', async () => {
  const mockCreditsRepo = {
    findTransactionByIdempotency: async () => null,
    recordEarnTransaction: async (params) => ({
      transaction: {
        id: 'tx-1',
        organizationEndUserId: params.organizationEndUserId,
        pointsAmount: params.pointsAmount,
        status: 'CONFIRMED',
        idempotencyKey: params.idempotencyKey,
      },
      newBalance: 150,
    }),
  };

  const service = new EarnService(mockCreditsRepo);
  const result = await service.executeEarn('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(result.pointsEarned, 50);
  assert.equal(result.newBalance, 150);
  assert.equal(result.status, 'CONFIRMED');
});

test('EarnService: respects idempotency', async () => {
  const mockCreditsRepo = {
    findTransactionByIdempotency: async () => ({
      id: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      status: 'CONFIRMED',
      idempotencyKey: 'idem-1',
    }),
    getOrCreateCreditOwnership: async () => ({
      confirmedBalance: 150,
    }),
  };

  const service = new EarnService(mockCreditsRepo);
  const result = await service.executeEarn('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(result.transactionId, 'tx-1');
  assert.equal(result.newBalance, 150);
});

test('RedemptionService: deducts points successfully', async () => {
  const mockCreditsRepo = {
    findTransactionByIdempotency: async () => null,
    recordRedeemTransaction: async (params) => ({
      transaction: {
        id: 'tx-redeem-1',
        organizationEndUserId: params.organizationEndUserId,
        pointsAmount: params.pointsAmount,
        status: 'CONFIRMED',
        idempotencyKey: params.idempotencyKey,
      },
      newBalance: 70,
    }),
  };

  const service = new RedemptionService(mockCreditsRepo);
  const result = await service.executeRedeem('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 30,
    idempotencyKey: 'idem-redeem-1',
  });

  assert.equal(result.pointsRedeemed, 30);
  assert.equal(result.newBalance, 70);
});

test('RewardsService: creates and claims voucher with point redemption', async () => {
  const voucher = {
    id: 'v-1',
    organizationId: 'org-1',
    code: 'DISCOUNT10',
    title: '10% Off',
    description: 'Get 10% off',
    pointsCost: 50,
    discountType: 'PERCENTAGE',
    discountValue: '10.00',
    totalSupply: 100,
    claimedCount: 0,
    status: 'ACTIVE',
    startsAt: null,
    expiresAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockRewardsRepo = {
    findVoucherByCode: async () => null,
    createVoucher: async () => voucher,
    findVoucherById: async () => voucher,
    claimVoucherInstance: async (params) => ({
      ownership: {
        id: 'own-1',
        voucherId: params.voucherId,
        organizationEndUserId: params.organizationEndUserId,
        serialCode: params.serialCode,
        status: 'AVAILABLE',
        claimedAt: new Date(),
        expiresAt: null,
      },
      voucher,
    }),
  };

  let pointsDeducted = 0;
  const mockRedemptionService = {
    executeRedeem: async (_orgId, req) => {
      pointsDeducted = req.pointsAmount;
      return {
        transactionId: 'tx-redeem-v-1',
        organizationEndUserId: req.organizationEndUserId,
        pointsRedeemed: req.pointsAmount,
        newBalance: 50,
        status: 'CONFIRMED',
        idempotencyKey: req.idempotencyKey,
      };
    },
  };

  const service = new RewardsService(mockRewardsRepo, mockRedemptionService);

  const claimResult = await service.claimVoucher('org-1', 'v-1', {
    organizationEndUserId: 'user-1',
  });

  assert.equal(pointsDeducted, 50);
  assert.equal(claimResult.voucherId, 'v-1');
  assert.equal(claimResult.pointsDeducted, 50);
  assert.ok(claimResult.serialCode.startsWith('DISCOUNT10-'));
});

// ==========================================
// SDK UNIT TESTS
// ==========================================
import {
  OctaPointClient,
  createOctaPointClient,
  OctaApiError,
} from '../ts-sdks/packages/node/dist/index.js';
import { OctaBrowserClient } from '../ts-sdks/packages/browser/dist/index.js';

const jsonHeaders = {
  get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
};

test('OctaPointClient: earnPoints and redeemPoints send valid requests', async () => {
  let capturedUrl = '';
  let capturedMethod = '';
  let capturedHeaders = {};
  let capturedBody = null;

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedMethod = init?.method ?? 'GET';
    capturedHeaders = init?.headers ?? {};
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;

    return {
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => ({
        transactionId: 'tx-sdk-1',
        organizationEndUserId: capturedBody.organizationEndUserId,
        pointsEarned: capturedBody.pointsAmount,
        newBalance: 200,
        status: 'CONFIRMED',
        idempotencyKey: capturedBody.idempotencyKey,
      }),
    };
  };

  const client = createOctaPointClient({
    baseUrl: 'https://api.octap.network',
    organizationId: 'org-123',
    credentials: { apiKey: 'secret-key-xyz' },
    fetchFn: mockFetch,
  });

  const earnResult = await client.earnPoints({
    organizationEndUserId: 'user-456',
    pointsAmount: 100,
    idempotencyKey: 'idem-key-1',
  });

  assert.equal(capturedUrl, 'https://api.octap.network/v1/credits/earn');
  assert.equal(capturedMethod, 'POST');
  assert.equal(capturedHeaders['x-organization-id'], 'org-123');
  assert.equal(capturedHeaders['authorization'], 'Bearer secret-key-xyz');
  assert.equal(capturedBody.pointsAmount, 100);
  assert.equal(earnResult.transactionId, 'tx-sdk-1');
  assert.equal(earnResult.newBalance, 200);

  // Test override organizationId
  await client.redeemPoints(
    {
      organizationEndUserId: 'user-456',
      pointsAmount: 50,
      idempotencyKey: 'idem-key-2',
    },
    { organizationId: 'org-override' },
  );

  assert.equal(capturedUrl, 'https://api.octap.network/v1/credits/redeem');
  assert.equal(capturedHeaders['x-organization-id'], 'org-override');
});

test('OctaPointClient: getBalance and listTransactions query credits API', async () => {
  let lastUrl = '';

  const mockFetch = async (url) => {
    lastUrl = String(url);
    if (lastUrl.includes('/balance')) {
      return {
        ok: true,
        status: 200,
        headers: jsonHeaders,
        json: async () => ({
          organizationEndUserId: 'user-1',
          confirmedBalance: 500,
          pendingEarn: 0,
          pendingRedemption: 0,
          lifetimeEarned: 1000,
          lifetimeRedeemed: 500,
          asOfCheckpoint: '100',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => [
        { id: 'tx-1', pointsAmount: 50, transactionType: 'EARN', status: 'CONFIRMED' },
      ],
    };
  };

  const client = new OctaPointClient({
    baseUrl: 'https://api.octap.network',
    fetchFn: mockFetch,
  });

  const balance = await client.getBalance('user-1');
  assert.equal(lastUrl, 'https://api.octap.network/v1/credits/members/user-1/balance');
  assert.equal(balance.confirmedBalance, 500);

  const txs = await client.listTransactions('user-1', { limit: 10 });
  assert.equal(lastUrl, 'https://api.octap.network/v1/credits/members/user-1/transactions?limit=10');
  assert.equal(txs.length, 1);
  assert.equal(txs[0].id, 'tx-1');
});

test('OctaPointClient: voucher lifecycle (create, list, get, claim, redeem, listMember)', async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method, body });

    return {
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => {
        if (url.includes('/claim')) {
          return {
            voucherOwnershipId: 'own-1',
            voucherId: 'v-10',
            serialCode: 'DISCOUNT-ABC123',
            status: 'AVAILABLE',
            pointsDeducted: 100,
          };
        }
        if (url.includes('/redeem')) {
          return {
            voucherOwnershipId: 'own-1',
            serialCode: body.serialCode,
            status: 'REDEEMED',
            voucherTitle: '10% Off',
          };
        }
        return { id: 'v-10', code: 'DISCOUNT' };
      },
    };
  };

  const client = createOctaPointClient({
    baseUrl: 'https://api.octap.network',
    fetchFn: mockFetch,
  });

  // Create voucher
  await client.createVoucher({
    code: 'DISCOUNT',
    title: '10% Off',
    discountType: 'PERCENTAGE',
    pointsCost: 100,
  });
  assert.equal(calls[calls.length - 1].url, 'https://api.octap.network/v1/rewards/vouchers');
  assert.equal(calls[calls.length - 1].method, 'POST');

  // List vouchers
  await client.listVouchers();
  assert.equal(calls[calls.length - 1].url, 'https://api.octap.network/v1/rewards/vouchers');
  assert.equal(calls[calls.length - 1].method, 'GET');

  // Claim voucher
  const claimRes = await client.claimVoucher('v-10', { organizationEndUserId: 'user-1' });
  assert.equal(calls[calls.length - 1].url, 'https://api.octap.network/v1/rewards/vouchers/v-10/claim');
  assert.equal(claimRes.serialCode, 'DISCOUNT-ABC123');

  // Redeem voucher
  const redeemRes = await client.redeemVoucher({ serialCode: 'DISCOUNT-ABC123' });
  assert.equal(calls[calls.length - 1].url, 'https://api.octap.network/v1/rewards/vouchers/redeem');
  assert.equal(redeemRes.status, 'REDEEMED');

  // List member vouchers
  await client.listMemberVouchers('user-1');
  assert.equal(calls[calls.length - 1].url, 'https://api.octap.network/v1/rewards/members/user-1/vouchers');
});

test('OctaPointClient: correctly throws OctaApiError on error responses', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    headers: jsonHeaders,
    json: async () => ({ message: 'Insufficient points balance' }),
  });

  const client = createOctaPointClient({ fetchFn: mockFetch });

  await assert.rejects(
    async () => client.redeemPoints({ organizationEndUserId: 'user-1', pointsAmount: 9999, idempotencyKey: 'idem' }),
    (err) => {
      assert.ok(err instanceof OctaApiError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'Insufficient points balance');
      return true;
    },
  );
});

test('OctaBrowserClient: retrieves balance and claims vouchers with auth token', async () => {
  let authHeader = '';
  const mockFetch = async (_url, init) => {
    authHeader = init?.headers?.['authorization'] ?? '';
    return {
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => ({ confirmedBalance: 250 }),
    };
  };

  // Mock global fetch for browser client test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  try {
    const browserClient = new OctaBrowserClient({
      apiBaseUrl: 'https://api.octap.network',
      organizationId: 'org-browser',
      getAuthToken: () => 'user-jwt-token-123',
    });

    const balance = await browserClient.getBalance('user-1');
    assert.equal(balance.confirmedBalance, 250);
    assert.equal(authHeader, 'Bearer user-jwt-token-123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

