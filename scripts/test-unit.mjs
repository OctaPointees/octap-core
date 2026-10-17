import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflector } from '@nestjs/core';
import { EarnService } from '../api/dist/domain/credits/earn.service.js';
import { RedemptionService } from '../api/dist/domain/credits/redemption.service.js';
import { RewardsService } from '../api/dist/domain/rewards/rewards.service.js';
import { ChainSubmitProcessor } from '../api/dist/domain/credits/chain-submit.processor.js';
import { CreditsService } from '../api/dist/domain/credits/credits.service.js';
import { ApiKeyGuard } from '../api/dist/infra/auth/api-key.guard.js';
import { ApiCredentialsService } from '../api/dist/infra/auth/api-credentials.service.js';
import { hashApiKey } from '../api/dist/infra/auth/api-key-hash.util.js';
import { Scopes, SCOPES_KEY } from '../api/dist/infra/auth/scopes.decorator.js';

test('EarnService: successfully records points and updates balance', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
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
    findMemberOrganizationId: async () => 'org-1',
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
    findMemberOrganizationId: async () => 'org-1',
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

  const mockCreditsRepo = { findMemberOrganizationId: async () => 'org-1' };
  const service = new RewardsService(mockRewardsRepo, mockRedemptionService, mockCreditsRepo);

  const claimResult = await service.claimVoucher('org-1', 'v-1', {
    organizationEndUserId: 'user-1',
  });

  assert.equal(pointsDeducted, 50);
  assert.equal(claimResult.voucherId, 'v-1');
  assert.equal(claimResult.pointsDeducted, 50);
  assert.ok(claimResult.serialCode.startsWith('DISCOUNT10-'));
});

test('RewardsService: a second claim of the same voucher by the same member is rejected', async () => {
  const voucher = {
    id: 'v-1',
    organizationId: 'org-1',
    code: 'FREESHIP',
    title: 'Free shipping',
    pointsCost: 0,
    discountType: 'FIXED_AMOUNT',
    totalSupply: 100,
    claimedCount: 1,
    status: 'ACTIVE',
    startsAt: null,
    expiresAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const mockRewardsRepo = {
    findVoucherById: async () => voucher,
    // Mirrors what voucher_ownership_voucher_member_idx now enforces at the DB level too.
    claimVoucherInstance: async () => {
      throw new Error('Voucher has already been claimed by this member');
    },
  };
  const service = new RewardsService(mockRewardsRepo, {});

  await assert.rejects(
    () => service.claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' }),
    /already been claimed/,
  );
});

// ==========================================
// CHAIN SUBMIT WORKER TESTS
// ==========================================

function fakeChainResult({ status = 'success', errorMessage, events = [] } = {}) {
  return {
    digest: 'DIGEST1',
    status,
    errorMessage,
    events,
    eventField(eventSuffix, field) {
      const event = events.find((e) => e.type.endsWith(`::${eventSuffix}`));
      return event?.parsedJson?.[field];
    },
  };
}

function fakeOperation(overrides = {}) {
  return {
    id: 'op-1',
    commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
    idempotencyKey: 'idem-chain-1',
    payload: {
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 10000,
    },
    ...overrides,
  };
}

test('ChainSubmitProcessor: opens an account, earns, and confirms on success', async () => {
  const calls = { openAccount: 0, earn: [], confirmEarnOnChain: null, markSubmitted: null, setSuiCreditAccountId: null };

  const operationsRepo = {
    markFailed: async () => assert.fail('should not mark failed on success'),
    markSubmitted: async (id, digest) => { calls.markSubmitted = { id, digest }; },
  };
  const creditsRepo = {
    getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: null }),
    setSuiCreditAccountId: async (id, accountId) => { calls.setSuiCreditAccountId = { id, accountId }; },
    confirmEarnOnChain: async (params) => { calls.confirmEarnOnChain = params; },
    failEarnOnChain: async () => assert.fail('should not fail on success'),
  };
  const suiClient = {
    openAccount: async () => {
      calls.openAccount += 1;
      return fakeChainResult({
        events: [{ type: 'pkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xacc1' } }],
      });
    },
    earn: async (params) => {
      calls.earn.push(params);
      return fakeChainResult({
        events: [{ type: 'pkg::credit_account::CreditEarned', parsedJson: { amount: '100' } }],
      });
    },
    issuerAddress: () => '0xissuer',
  };

  const processor = new ChainSubmitProcessor(operationsRepo, creditsRepo, suiClient);
  await processor.process(fakeOperation());

  assert.equal(calls.openAccount, 1);
  assert.equal(calls.setSuiCreditAccountId.accountId, '0xacc1');
  assert.equal(calls.earn[0].accountId, '0xacc1');
  assert.equal(calls.earn[0].purchaseAmount, 10000);
  assert.equal(calls.confirmEarnOnChain.reservedPointsAmount, 10000);
  assert.equal(calls.confirmEarnOnChain.confirmedPointsAmount, 100);
  assert.equal(calls.confirmEarnOnChain.digest, 'DIGEST1');
  assert.equal(calls.markSubmitted.digest, 'DIGEST1');
});

test('ChainSubmitProcessor: reuses an existing on-chain account without reopening', async () => {
  const creditsRepo = {
    getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: '0xexisting' }),
    confirmEarnOnChain: async () => {},
  };
  const suiClient = {
    openAccount: async () => assert.fail('should not reopen an existing account'),
    earn: async (params) => {
      assert.equal(params.accountId, '0xexisting');
      return fakeChainResult({
        events: [{ type: 'pkg::credit_account::CreditEarned', parsedJson: { amount: '50' } }],
      });
    },
    issuerAddress: () => '0xissuer',
  };
  const operationsRepo = { markSubmitted: async () => {} };

  const processor = new ChainSubmitProcessor(operationsRepo, creditsRepo, suiClient);
  await processor.process(fakeOperation());
});

test('ChainSubmitProcessor: reverts the pending reservation when the chain call fails', async () => {
  let failedCall = null;
  let markedFailed = null;

  const creditsRepo = {
    getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: '0xexisting' }),
    confirmEarnOnChain: async () => assert.fail('should not confirm on failure'),
    failEarnOnChain: async (params) => { failedCall = params; },
  };
  const suiClient = {
    earn: async () => fakeChainResult({ status: 'failure', errorMessage: 'EInsufficientBalance' }),
    issuerAddress: () => '0xissuer',
  };
  const operationsRepo = {
    markFailed: async (id, message) => { markedFailed = { id, message }; },
  };

  const processor = new ChainSubmitProcessor(operationsRepo, creditsRepo, suiClient);
  await processor.process(fakeOperation());

  assert.equal(failedCall.reservedPointsAmount, 10000);
  assert.equal(markedFailed.message, 'EInsufficientBalance');
});

test('ChainSubmitProcessor: rejects an unsupported command type without touching chain state', async () => {
  let markedFailed = null;
  const operationsRepo = { markFailed: async (id, message) => { markedFailed = { id, message }; } };
  const creditsRepo = { getCreditOwnershipByEndUserId: async () => assert.fail('should not look up ownership') };
  const suiClient = { earn: async () => assert.fail('should not call chain') };

  const processor = new ChainSubmitProcessor(operationsRepo, creditsRepo, suiClient);
  await processor.process(fakeOperation({ commandType: 'SOMETHING_ELSE' }));

  assert.match(markedFailed.message, /Unsupported commandType/);
});

test('EarnService: rejects earning for a member belonging to another organization', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async (id) => (id === 'user-org1' ? 'org-1' : 'org-2'),
    findTransactionByIdempotency: async () => {
      throw new Error('should not be reached: ownership check must happen first');
    },
  };
  const service = new EarnService(mockCreditsRepo);

  await assert.rejects(
    () => service.executeEarn('org-1', { organizationEndUserId: 'user-org2', pointsAmount: 50, idempotencyKey: 'k' }),
    /was not found for this organization/,
  );
});

test('RedemptionService: rejects redeeming for a member belonging to another organization', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async (id) => (id === 'user-org1' ? 'org-1' : 'org-2'),
    findTransactionByIdempotency: async () => {
      throw new Error('should not be reached: ownership check must happen first');
    },
  };
  const service = new RedemptionService(mockCreditsRepo);

  await assert.rejects(
    () => service.executeRedeem('org-1', { organizationEndUserId: 'user-org2', pointsAmount: 10, idempotencyKey: 'k' }),
    /was not found for this organization/,
  );
});

test('RewardsService: claiming a free voucher (no redeem call) still rejects a cross-tenant member', async () => {
  const freeVoucher = {
    id: 'v-free',
    organizationId: 'org-1',
    code: 'FREEGIFT',
    pointsCost: 0,
    totalSupply: null,
    claimedCount: 0,
    status: 'ACTIVE',
    expiresAt: null,
  };
  const mockRewardsRepo = {
    findVoucherById: async () => freeVoucher,
    claimVoucherInstance: async () => {
      throw new Error('should not be reached: membership check must happen first');
    },
  };
  const mockCreditsRepo = { findMemberOrganizationId: async (id) => (id === 'user-org1' ? 'org-1' : 'org-2') };
  const service = new RewardsService(mockRewardsRepo, {}, mockCreditsRepo);

  await assert.rejects(
    () => service.claimVoucher('org-1', 'v-free', { organizationEndUserId: 'user-org2' }),
    /was not found for this organization/,
  );
});

test('RewardsService: listMemberVouchers rejects a cross-tenant member instead of silently returning an empty list', async () => {
  const mockRewardsRepo = {
    listOwnershipsByMember: async () => {
      throw new Error('should not be reached: membership check must happen first');
    },
  };
  const mockCreditsRepo = { findMemberOrganizationId: async () => 'org-2' };
  const service = new RewardsService(mockRewardsRepo, {}, mockCreditsRepo);

  await assert.rejects(
    () => service.listMemberVouchers('org-1', 'user-org2'),
    /was not found for this organization/,
  );
});

// ==========================================
// TENANT AUTHORIZATION TESTS (OCT-35)
// ==========================================

function mockExecutionContext({ headers, handler = () => {}, klass = class {} }) {
  const request = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => klass,
    _request: request,
  };
}

test('ApiKeyGuard: valid key attaches tenant context and passes', async () => {
  const credential = {
    id: 'cred-1',
    organizationId: 'org-1',
    status: 'ACTIVE',
    expiresAt: null,
    scopes: ['read', 'write'],
  };
  let touched = false;
  const repo = {
    findByKeyHash: async (hash) => (hash === hashApiKey('octap_live_valid') ? credential : null),
    touchLastUsed: async () => {
      touched = true;
    },
  };
  const guard = new ApiKeyGuard(repo, new Reflector());

  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_valid' } });
  const result = await guard.canActivate(ctx);

  assert.equal(result, true);
  assert.deepEqual(ctx._request.tenant, { organizationId: 'org-1', credentialId: 'cred-1', scopes: ['read', 'write'] });
  assert.equal(touched, true);
});

test('ApiKeyGuard: rejects a missing Authorization header', async () => {
  const guard = new ApiKeyGuard({ findByKeyHash: async () => null }, new Reflector());
  const ctx = mockExecutionContext({ headers: {} });
  await assert.rejects(() => guard.canActivate(ctx), /Missing API credential/);
});

test('ApiKeyGuard: rejects an unknown or revoked key', async () => {
  const repo = { findByKeyHash: async () => ({ status: 'REVOKED' }) };
  const guard = new ApiKeyGuard(repo, new Reflector());
  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_revoked' } });
  await assert.rejects(() => guard.canActivate(ctx), /invalid or has been revoked/);
});

test('ApiKeyGuard: rejects an expired key', async () => {
  const repo = {
    findByKeyHash: async () => ({
      id: 'cred-2',
      organizationId: 'org-1',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000),
      scopes: ['read'],
    }),
  };
  const guard = new ApiKeyGuard(repo, new Reflector());
  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_expired' } });
  await assert.rejects(() => guard.canActivate(ctx), /expired/);
});

test('ApiKeyGuard: rejects a stolen key replayed with a different org header (anti cross-tenant spoofing)', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-3', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['read'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector());
  const ctx = mockExecutionContext({
    headers: { authorization: 'Bearer octap_live_org1key', 'x-organization-id': 'org-2' },
  });
  await assert.rejects(() => guard.canActivate(ctx), /does not match this API credential/);
});

test('ApiKeyGuard: blocks a write attempt from a read-only credential (privilege escalation)', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-4', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['read'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector());

  // Applying the decorator factory manually (no TS decorator syntax in a plain .mjs test file)
  // is equivalent to writing `@Scopes('write')` on this method.
  function writeRoute() {}
  Scopes('write')(writeRoute, 'writeRoute', { value: writeRoute });
  assert.deepEqual(Reflect.getMetadata(SCOPES_KEY, writeRoute), ['write']);

  const ctx = mockExecutionContext({
    headers: { authorization: 'Bearer octap_live_readonly' },
    handler: writeRoute,
    klass: class Controller {},
  });

  await assert.rejects(() => guard.canActivate(ctx), /missing the required "write" scope/);
});

test('ApiCredentialsService: issues a key whose raw value is never persisted, then revoke/rotate lifecycle', async () => {
  const store = new Map();
  let nextId = 1;
  const repo = {
    create: async (data) => {
      const row = { id: `cred-${nextId++}`, status: 'ACTIVE', ...data };
      store.set(row.id, row);
      return row;
    },
    findById: async (id) => store.get(id) ?? null,
    revoke: async (id) => {
      const row = store.get(id);
      row.status = 'REVOKED';
      return row;
    },
  };
  const service = new ApiCredentialsService(repo);

  const { credential, rawKey } = await service.issue('org-1', 'pos-terminal-1');
  assert.ok(rawKey.startsWith('octap_live_'));
  assert.notEqual(credential.keyHash, rawKey);
  assert.equal(credential.status, 'ACTIVE');

  // Cross-tenant revoke must fail closed, not silently no-op.
  await assert.rejects(() => service.revoke('org-OTHER', credential.id), /not found/);

  const revoked = await service.revoke('org-1', credential.id);
  assert.equal(revoked.status, 'REVOKED');

  const { credential: rotated, rawKey: rotatedKey } = await service.rotate('org-1', credential.id);
  assert.notEqual(rotatedKey, rawKey);
  assert.equal(store.get(credential.id).status, 'REVOKED');
  assert.equal(rotated.status, 'ACTIVE');
});

test('CreditsService: a member from another organization is treated as not found', async () => {
  const repo = {
    findMemberOrganizationId: async (id) => (id === 'user-org1' ? 'org-1' : 'org-2'),
    getOrCreateCreditOwnership: async () => ({
      confirmedBalance: 100,
      pendingEarn: 0,
      pendingRedemption: 0,
      lifetimeEarned: 100,
      lifetimeRedeemed: 0,
      asOfCheckpoint: null,
    }),
  };
  const service = new CreditsService(repo);

  const balance = await service.getBalance('org-1', 'user-org1');
  assert.equal(balance.confirmedBalance, 100);

  await assert.rejects(() => service.getBalance('org-1', 'user-org2'), /was not found for this organization/);
});

test('RewardsService: a voucher belonging to another organization is treated as not found', async () => {
  const voucherOrg1 = {
    id: 'v-1',
    organizationId: 'org-1',
    code: 'DISCOUNT10',
    title: '10% Off',
    description: 'Get 10% off',
    pointsCost: 0,
    discountType: 'PERCENTAGE',
    discountValue: '10.00',
    totalSupply: null,
    claimedCount: 0,
    status: 'ACTIVE',
    startsAt: null,
    expiresAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const repo = {
    findVoucherById: async (id) => (id === 'v-1' ? voucherOrg1 : null),
  };
  const service = new RewardsService(repo, {});

  const voucher = await service.getVoucher('org-1', 'v-1');
  assert.equal(voucher.id, 'v-1');

  await assert.rejects(() => service.getVoucher('org-2', 'v-1'), /not found/);
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

