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
import { RequireSignedRequest, REQUIRE_SIGNED_REQUEST_KEY } from '../api/dist/infra/auth/signed-request.decorator.js';
import { buildCanonicalRequest, signCanonicalRequest } from '../api/dist/infra/auth/request-signing.util.js';
import { RATE_LIMIT_MAX_REQUESTS } from '../api/dist/infra/auth/rate-limit.util.js';

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

  const mockWebhooks = { emit: async () => {} };
  const service = new EarnService(mockCreditsRepo, mockWebhooks);
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

  const mockWebhooks = { emit: async () => {} };
  const service = new RedemptionService(mockCreditsRepo, mockWebhooks);
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
  const mockCreditsRepo = { findMemberOrganizationId: async () => 'org-1' };
  const service = new RewardsService(mockRewardsRepo, {}, mockCreditsRepo);

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
    findBeneficiaryAddress: async () => '0xbeneficiary',
    setSuiCreditAccountId: async (id, accountId) => { calls.setSuiCreditAccountId = { id, accountId }; },
    confirmEarnOnChain: async (params) => { calls.confirmEarnOnChain = params; },
    failEarnOnChain: async () => assert.fail('should not fail on success'),
  };
  const suiClient = {
    openAccount: async (beneficiaryAddress) => {
      calls.openAccount += 1;
      calls.openAccountBeneficiary = beneficiaryAddress;
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
  // OCT-55: must open under the member's real zkLogin address, never a placeholder.
  assert.equal(calls.openAccountBeneficiary, '0xbeneficiary');
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
  const request = { headers, method: 'GET', url: '/v1/test', rawBody: Buffer.from('') };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => klass,
    _request: request,
  };
}

/** A Redis double that always allows rate limiting and nonce claims — for tests not about those. */
function mockRedisAllowing() {
  const store = new Map();
  return {
    incr: async (key) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    expire: async () => 1,
    set: async (key, value, _ex, _ttl, nx) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
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
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_valid' } });
  const result = await guard.canActivate(ctx);

  assert.equal(result, true);
  assert.deepEqual(ctx._request.tenant, { organizationId: 'org-1', credentialId: 'cred-1', scopes: ['read', 'write'] });
  assert.equal(touched, true);
});

test('ApiKeyGuard: rejects a missing Authorization header', async () => {
  const guard = new ApiKeyGuard({ findByKeyHash: async () => null }, new Reflector(), mockRedisAllowing());
  const ctx = mockExecutionContext({ headers: {} });
  await assert.rejects(() => guard.canActivate(ctx), /Missing API credential/);
});

test('ApiKeyGuard: rejects an unknown or revoked key', async () => {
  const repo = { findByKeyHash: async () => ({ status: 'REVOKED' }) };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());
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
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());
  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_expired' } });
  await assert.rejects(() => guard.canActivate(ctx), /expired/);
});

test('ApiKeyGuard: rejects a stolen key replayed with a different org header (anti cross-tenant spoofing)', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-3', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['read'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());
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
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

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

test('ApiKeyGuard: rejects once the per-credential rate limit is exceeded', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-5', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['read'] }),
    touchLastUsed: async () => {},
  };
  const redis = mockRedisAllowing();
  const guard = new ApiKeyGuard(repo, new Reflector(), redis);
  const makeCtx = () => mockExecutionContext({ headers: { authorization: 'Bearer octap_live_ratelimited' } });

  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    assert.equal(await guard.canActivate(makeCtx()), true);
  }
  await assert.rejects(() => guard.canActivate(makeCtx()), /Rate limit exceeded/);
});

test('ApiKeyGuard: fails closed (503) when Redis is unreachable for rate limiting', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-6', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['read'] }),
    touchLastUsed: async () => {},
  };
  const brokenRedis = { incr: async () => { throw new Error('ECONNREFUSED'); } };
  const guard = new ApiKeyGuard(repo, new Reflector(), brokenRedis);
  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_x' } });

  await assert.rejects(() => guard.canActivate(ctx), /Rate limiting is temporarily unavailable/);
});

function signedRequestContext({ credentialKey = 'octap_live_signed', signingKey, method = 'POST', path = '/v1/api-credentials', body = '{}', handler, overrideSignature, overrideNonce, overrideTimestamp }) {
  const timestamp = (overrideTimestamp ?? Math.floor(Date.now() / 1000)).toString();
  const nonce = overrideNonce ?? 'nonce-1';
  const canonical = buildCanonicalRequest({ method, path, timestamp, nonce, rawBody: body });
  const signature = overrideSignature ?? signCanonicalRequest(canonical, signingKey);
  return mockExecutionContext({
    headers: {
      authorization: `Bearer ${credentialKey}`,
      'x-octap-timestamp': timestamp,
      'x-octap-nonce': nonce,
      'x-octap-signature': signature,
    },
    handler: handler ?? signedHandlerFixture(),
  });
}

function signedHandlerFixture() {
  function route() {}
  RequireSignedRequest()(route, 'route', { value: route });
  assert.equal(Reflect.getMetadata(REQUIRE_SIGNED_REQUEST_KEY, route), true);
  return route;
}

test('ApiKeyGuard: a correctly signed request on a @RequireSignedRequest() route passes', async () => {
  const signingKey = hashApiKey('octap_live_signed');
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-7', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

  const ctx = signedRequestContext({ signingKey });
  // mockExecutionContext() defaults method/url; override to match what was signed above.
  ctx._request.method = 'POST';
  ctx._request.url = '/v1/api-credentials';
  ctx._request.rawBody = Buffer.from('{}');

  assert.equal(await guard.canActivate(ctx), true);
});

test('ApiKeyGuard: a signed route rejects a request missing the signature headers', async () => {
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-8', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());
  const ctx = mockExecutionContext({ headers: { authorization: 'Bearer octap_live_signed' }, handler: signedHandlerFixture() });

  await assert.rejects(() => guard.canActivate(ctx), /requires a signed request/);
});

test('ApiKeyGuard: a signed route rejects a tampered signature', async () => {
  const signingKey = hashApiKey('octap_live_signed');
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-9', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

  const ctx = signedRequestContext({ signingKey, overrideSignature: 'a'.repeat(64) });
  ctx._request.method = 'POST';
  ctx._request.url = '/v1/api-credentials';
  ctx._request.rawBody = Buffer.from('{}');

  await assert.rejects(() => guard.canActivate(ctx), /Invalid request signature/);
});

test('ApiKeyGuard: a signed route rejects a stale timestamp (outside the replay window)', async () => {
  const signingKey = hashApiKey('octap_live_signed');
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-10', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

  const ctx = signedRequestContext({ signingKey, overrideTimestamp: Math.floor(Date.now() / 1000) - 10_000 });
  ctx._request.method = 'POST';
  ctx._request.url = '/v1/api-credentials';
  ctx._request.rawBody = Buffer.from('{}');

  await assert.rejects(() => guard.canActivate(ctx), /outside the replay window/);
});

test('ApiKeyGuard: a signed route rejects a replayed (already-used) nonce', async () => {
  const signingKey = hashApiKey('octap_live_signed');
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-11', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const redis = mockRedisAllowing();
  const guard = new ApiKeyGuard(repo, new Reflector(), redis);

  const makeSignedCtx = () => {
    const ctx = signedRequestContext({ signingKey, overrideNonce: 'reused-nonce' });
    ctx._request.method = 'POST';
    ctx._request.url = '/v1/api-credentials';
    ctx._request.rawBody = Buffer.from('{}');
    return ctx;
  };

  assert.equal(await guard.canActivate(makeSignedCtx()), true);
  await assert.rejects(() => guard.canActivate(makeSignedCtx()), /already used, or replay protection is unavailable/);
});

test('ApiKeyGuard: a signed route fails closed when Redis is unreachable for nonce claims', async () => {
  const signingKey = hashApiKey('octap_live_signed');
  const repo = {
    findByKeyHash: async () => ({ id: 'cred-12', organizationId: 'org-1', status: 'ACTIVE', expiresAt: null, scopes: ['admin'] }),
    touchLastUsed: async () => {},
  };
  const brokenNonceRedis = {
    incr: async () => 1,
    expire: async () => 1,
    set: async () => { throw new Error('ECONNREFUSED'); },
  };
  const guard = new ApiKeyGuard(repo, new Reflector(), brokenNonceRedis);

  const ctx = signedRequestContext({ signingKey });
  ctx._request.method = 'POST';
  ctx._request.url = '/v1/api-credentials';
  ctx._request.rawBody = Buffer.from('{}');

  await assert.rejects(() => guard.canActivate(ctx), /already used, or replay protection is unavailable/);
});

test('ApiKeyGuard: rotating a credential invalidates signatures made with the old signing key', async () => {
  const oldSigningKey = hashApiKey('octap_live_before_rotation');
  // After rotation the credential's own keyHash changes; a bearer lookup with the OLD raw key
  // no longer resolves any ACTIVE credential at all, so a request signed with the old
  // derived key is rejected at the bearer-auth step, before signature verification even runs.
  const repo = { findByKeyHash: async () => null };
  const guard = new ApiKeyGuard(repo, new Reflector(), mockRedisAllowing());

  const ctx = signedRequestContext({ credentialKey: 'octap_live_before_rotation', signingKey: oldSigningKey });
  ctx._request.method = 'POST';
  ctx._request.url = '/v1/api-credentials';
  ctx._request.rawBody = Buffer.from('{}');

  await assert.rejects(() => guard.canActivate(ctx), /invalid or has been revoked/);
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
// REVERSAL SERVICE TESTS (OCT-51)
// ==========================================
import { ReversalService } from '../api/dist/domain/credits/reversal.service.js';

function confirmedEarn(overrides = {}) {
  return {
    id: 'tx-earn-1',
    organizationId: 'org-1',
    organizationEndUserId: 'user-1',
    transactionType: 'EARN',
    pointsAmount: 50,
    status: 'CONFIRMED',
    idempotencyKey: 'earn-1',
    reversesTransactionId: null,
    ...overrides,
  };
}

test('ReversalService: reverses a CONFIRMED earn and can drive the balance negative (clawback debt)', async () => {
  let reversedStatus;
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async (orgId, id) => (orgId === 'org-1' && id === 'tx-earn-1' ? confirmedEarn() : null),
    recordReversalTransaction: async (params) => {
      reversedStatus = 'REVERSED';
      return {
        reversal: { id: 'tx-reversal-1', idempotencyKey: params.idempotencyKey, pointsAmount: params.original.pointsAmount },
        reversedOriginal: { ...params.original, status: 'REVERSED' },
        // Already spent elsewhere: reversing this earn pushes the balance negative.
        newBalance: -20,
      };
    },
  };
  const service = new ReversalService(repo);

  const result = await service.reverseTransaction('org-1', {
    transactionId: 'tx-earn-1',
    idempotencyKey: 'reverse-1',
    reason: 'Chargeback from payment provider',
  });

  assert.equal(reversedStatus, 'REVERSED');
  assert.equal(result.reversedTransactionId, 'tx-earn-1');
  assert.equal(result.newBalance, -20);
  assert.equal(result.balanceWentNegative, true);
});

test('ReversalService: the same idempotency key replays the same result instead of reversing twice', async () => {
  let recordCalls = 0;
  const existingReversal = {
    id: 'tx-reversal-1',
    organizationEndUserId: 'user-1',
    transactionType: 'REVERSAL',
    pointsAmount: 50,
    idempotencyKey: 'reverse-1',
    reversesTransactionId: 'tx-earn-1',
  };
  const repo = {
    findTransactionByIdempotency: async (orgId, key) => (key === 'reverse-1' ? existingReversal : null),
    recordReversalTransaction: async () => {
      recordCalls += 1;
      throw new Error('should not be called on idempotent replay');
    },
    getOrCreateCreditOwnership: async () => ({ confirmedBalance: 30 }),
  };
  const service = new ReversalService(repo);

  const result = await service.reverseTransaction('org-1', {
    transactionId: 'tx-earn-1',
    idempotencyKey: 'reverse-1',
    reason: 'Chargeback from payment provider',
  });

  assert.equal(recordCalls, 0);
  assert.equal(result.reversalTransactionId, 'tx-reversal-1');
  assert.equal(result.newBalance, 30);
});

test('ReversalService: rejects reversing a transaction that is not CONFIRMED', async () => {
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async () => confirmedEarn({ status: 'REVERSED' }),
  };
  const service = new ReversalService(repo);

  await assert.rejects(
    () => service.reverseTransaction('org-1', { transactionId: 'tx-earn-1', idempotencyKey: 'reverse-2', reason: 'retry' }),
    /already been reversed/,
  );
});

test('ReversalService: rejects reversing a transaction belonging to another organization', async () => {
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async (orgId) => (orgId === 'org-1' ? confirmedEarn() : null),
  };
  const service = new ReversalService(repo);

  await assert.rejects(
    () => service.reverseTransaction('org-2', { transactionId: 'tx-earn-1', idempotencyKey: 'reverse-3', reason: 'x' }),
    /was not found/,
  );
});

test('ReversalService: a reversal cannot itself be reversed', async () => {
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async () => confirmedEarn({ transactionType: 'REVERSAL' }),
  };
  const service = new ReversalService(repo);

  await assert.rejects(
    () => service.reverseTransaction('org-1', { transactionId: 'tx-reversal-1', idempotencyKey: 'reverse-4', reason: 'x' }),
    /cannot be reversed/,
  );
});

test('ReversalService: requires a reason', async () => {
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async () => confirmedEarn(),
  };
  const service = new ReversalService(repo);

  await assert.rejects(
    () => service.reverseTransaction('org-1', { transactionId: 'tx-earn-1', idempotencyKey: 'reverse-5', reason: '  ' }),
    /reason is required/,
  );
});

test('ReversalService: a concurrent double reversal is rejected (race caught by the unique index)', async () => {
  const repo = {
    findTransactionByIdempotency: async () => null,
    findTransactionByIdForOrganization: async () => confirmedEarn(),
    recordReversalTransaction: async () => {
      // What a unique-constraint violation on reverses_transaction_id surfaces as.
      throw new Error('duplicate key value violates unique constraint "loyalty_transactions_reverses_transaction_id_unique"');
    },
  };
  const service = new ReversalService(repo);

  await assert.rejects(
    () => service.reverseTransaction('org-1', { transactionId: 'tx-earn-1', idempotencyKey: 'reverse-6', reason: 'x' }),
    /unique constraint/,
  );
});

// ==========================================
// WEBHOOKS TESTS (OCT-54)
// ==========================================
import { WebhookEndpointsService } from '../api/dist/domain/webhooks/webhook-endpoints.service.js';
import { WebhookDeliveryService } from '../api/dist/domain/webhooks/webhook-delivery.service.js';
import { WebhookDeliveryProcessor, MAX_DELIVERY_ATTEMPTS } from '../api/dist/domain/webhooks/webhook-delivery.processor.js';
import { signWebhookPayload, verifyWebhookSignature, generateWebhookSecret } from '../api/dist/domain/webhooks/webhook-signing.util.js';
import { verifyWebhookSignature as sdkVerifyWebhookSignature } from '../ts-sdks/packages/node/dist/webhooks.js';

test('webhook-signing: a valid signature verifies and a tampered body does not', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: 'evt-1', type: 'credits.earned' });
  const signature = signWebhookPayload(body, secret);

  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body + ' ', signature, secret), false);
  assert.equal(verifyWebhookSignature(body, signature, generateWebhookSecret()), false);
});

test('webhook-signing: the server util and the Node SDK verifier agree (cross-package)', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: 'evt-2', type: 'credits.redeemed' });
  const signature = signWebhookPayload(body, secret);

  assert.equal(sdkVerifyWebhookSignature(body, signature, secret), true);
  assert.equal(sdkVerifyWebhookSignature(body, 'not-hex-but-also-wrong', secret), false);
});

test('WebhookEndpointsService: register returns the secret once, list never includes it', async () => {
  const store = new Map();
  let nextId = 1;
  const repo = {
    createEndpoint: async (data) => {
      const row = { id: `ep-${nextId++}`, status: 'ACTIVE', ...data };
      store.set(row.id, row);
      return row;
    },
    listEndpoints: async (orgId) => [...store.values()].filter((e) => e.organizationId === orgId),
    findEndpointForOrganization: async (orgId, id) => (store.get(id)?.organizationId === orgId ? store.get(id) : null),
    setEndpointStatus: async (id, status) => {
      const row = store.get(id);
      row.status = status;
      return row;
    },
    rotateEndpointSecret: async (id, secret) => {
      const row = store.get(id);
      row.secret = secret;
      return row;
    },
  };
  const service = new WebhookEndpointsService(repo);

  const registered = await service.register('org-1', 'https://merchant.example/hooks', 'POS integration');
  assert.ok(registered.secret.startsWith('whsec_'));

  const listed = await service.list('org-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secret, undefined);
  assert.equal(listed[0].url, 'https://merchant.example/hooks');
});

test('WebhookEndpointsService: rejects an invalid URL and cross-tenant endpoint management', async () => {
  const repo = {
    createEndpoint: async () => { throw new Error('should not be called'); },
    findEndpointForOrganization: async () => null,
  };
  const service = new WebhookEndpointsService(repo);

  await assert.rejects(() => service.register('org-1', 'not-a-url'), /valid http/);
  await assert.rejects(() => service.disable('org-2', 'ep-1'), /was not found/);
});

test('WebhookDeliveryService: emit enqueues only to ACTIVE endpoints and never throws', async () => {
  const enqueued = [];
  const repo = {
    listActiveEndpoints: async () => [{ id: 'ep-active' }],
    enqueueDelivery: async (params) => enqueued.push(params),
  };
  const service = new WebhookDeliveryService(repo);

  await service.emit('org-1', 'credits.earned', { transactionId: 'tx-1' });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].eventType, 'credits.earned');

  const throwingRepo = { listActiveEndpoints: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(() => new WebhookDeliveryService(throwingRepo).emit('org-1', 'credits.earned', {}));
});

test('WebhookDeliveryService: replay only works on a DEAD_LETTER delivery, same org', async () => {
  const deadLetter = { id: 'dlv-1', organizationId: 'org-1', status: 'DEAD_LETTER' };
  const repo = {
    findDeliveryForOrganization: async (orgId, id) => (orgId === 'org-1' && id === 'dlv-1' ? deadLetter : null),
    resetForReplay: async (id) => ({ id, status: 'PENDING', attemptCount: 0 }),
  };
  const service = new WebhookDeliveryService(repo);

  const replayed = await service.replay('org-1', 'dlv-1');
  assert.equal(replayed.status, 'PENDING');
  assert.equal(replayed.id, 'dlv-1'); // identity preserved

  await assert.rejects(() => service.replay('org-2', 'dlv-1'), /was not found/);

  const pendingRepo = { findDeliveryForOrganization: async () => ({ id: 'dlv-2', organizationId: 'org-1', status: 'PENDING' }) };
  await assert.rejects(() => new WebhookDeliveryService(pendingRepo).replay('org-1', 'dlv-2'), /Only a DEAD_LETTER/);
});

function withMockFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('WebhookDeliveryProcessor: a successful delivery is marked DELIVERED with a valid signature', async () => {
  const secret = generateWebhookSecret();
  const endpoint = { id: 'ep-1', url: 'https://merchant.example/hooks', secret, status: 'ACTIVE' };
  const delivery = { id: 'dlv-1', endpointId: 'ep-1', eventType: 'credits.earned', payload: { a: 1 }, attemptCount: 1 };
  let markedDeliveredStatus;
  let seenHeaders;
  const repo = {
    findEndpointById: async () => endpoint,
    markDelivered: async (_id, status) => {
      markedDeliveredStatus = status;
    },
  };
  const processor = new WebhookDeliveryProcessor(repo);

  await withMockFetch(
    async (url, init) => {
      seenHeaders = init.headers;
      const expectedSig = signWebhookPayload(init.body, secret);
      assert.equal(init.headers['x-octap-signature'], expectedSig);
      return { ok: true, status: 200 };
    },
    () => processor.process(delivery),
  );

  assert.equal(markedDeliveredStatus, 200);
  assert.equal(seenHeaders['x-octap-event-id'], 'dlv-1');
  assert.equal(seenHeaders['x-octap-event-type'], 'credits.earned');
});

test('WebhookDeliveryProcessor: a non-2xx response schedules a retry, not a dead-letter, below the attempt cap', async () => {
  const endpoint = { id: 'ep-1', url: 'https://merchant.example/hooks', secret: generateWebhookSecret(), status: 'ACTIVE' };
  const delivery = { id: 'dlv-1', endpointId: 'ep-1', eventType: 'credits.earned', payload: {}, attemptCount: 2 };
  let scheduled;
  const repo = {
    findEndpointById: async () => endpoint,
    scheduleRetry: async (id, nextAttemptAt, status, error) => {
      scheduled = { id, nextAttemptAt, status, error };
    },
  };
  const processor = new WebhookDeliveryProcessor(repo);

  await withMockFetch(async () => ({ ok: false, status: 503 }), () => processor.process(delivery));

  assert.equal(scheduled.id, 'dlv-1');
  assert.equal(scheduled.status, 503);
  assert.ok(scheduled.nextAttemptAt > new Date());
});

test('WebhookDeliveryProcessor: exhausting the attempt cap dead-letters instead of retrying again', async () => {
  const endpoint = { id: 'ep-1', url: 'https://merchant.example/hooks', secret: generateWebhookSecret(), status: 'ACTIVE' };
  const delivery = { id: 'dlv-1', endpointId: 'ep-1', eventType: 'credits.earned', payload: {}, attemptCount: MAX_DELIVERY_ATTEMPTS };
  let deadLettered = false;
  const repo = {
    findEndpointById: async () => endpoint,
    markDeadLetter: async () => {
      deadLettered = true;
    },
    scheduleRetry: async () => {
      throw new Error('should not retry past the cap');
    },
  };
  const processor = new WebhookDeliveryProcessor(repo);

  await withMockFetch(async () => ({ ok: false, status: 500 }), () => processor.process(delivery));

  assert.equal(deadLettered, true);
});

test('WebhookDeliveryProcessor: a disabled endpoint dead-letters immediately without an HTTP attempt', async () => {
  const delivery = { id: 'dlv-1', endpointId: 'ep-1', eventType: 'credits.earned', payload: {}, attemptCount: 1 };
  let fetchCalled = false;
  let deadLettered = false;
  const repo = {
    findEndpointById: async () => ({ id: 'ep-1', status: 'DISABLED' }),
    markDeadLetter: async () => {
      deadLettered = true;
    },
  };
  const processor = new WebhookDeliveryProcessor(repo);

  await withMockFetch(
    async () => {
      fetchCalled = true;
      return { ok: true, status: 200 };
    },
    () => processor.process(delivery),
  );

  assert.equal(fetchCalled, false);
  assert.equal(deadLettered, true);
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

import { IdentityService } from '../api/dist/domain/identity/identity.service.js';
import { SponsoredTransactionService } from '../api/dist/domain/identity/sponsored-transaction.service.js';

test('IdentityService: loginWithGoogle creates a new end user on first login', async () => {
  let created = null;
  const mockRepo = {
    findEndUserBySuiAddress: async () => null,
    createEndUser: async (params) => {
      created = { id: 'end-user-1', ...params };
      return created;
    },
  };
  const mockEnoki = {
    resolveZkLoginAddress: async (jwt) => {
      assert.equal(jwt, 'google-id-token');
      return { address: '0xabc', publicKey: 'pk', salt: 'salt' };
    },
  };

  const service = new IdentityService(mockRepo, mockEnoki);
  const result = await service.loginWithGoogle('google-id-token');

  assert.equal(result.endUserId, 'end-user-1');
  assert.equal(result.suiAddress, '0xabc');
  assert.equal(result.isNewUser, true);
  assert.equal(created.suiAddress, '0xabc');
});

test('IdentityService: loginWithGoogle returns the existing end user without creating a duplicate', async () => {
  let createCalled = false;
  const mockRepo = {
    findEndUserBySuiAddress: async (address) => {
      assert.equal(address, '0xabc');
      return { id: 'end-user-1', suiAddress: '0xabc' };
    },
    createEndUser: async () => {
      createCalled = true;
      throw new Error('should not create');
    },
  };
  const mockEnoki = { resolveZkLoginAddress: async () => ({ address: '0xabc', publicKey: 'pk', salt: 'salt' }) };

  const service = new IdentityService(mockRepo, mockEnoki);
  const result = await service.loginWithGoogle('google-id-token');

  assert.equal(result.isNewUser, false);
  assert.equal(result.endUserId, 'end-user-1');
  assert.equal(createCalled, false);
});

test('IdentityService: loginWithGoogle requires an idToken', async () => {
  const service = new IdentityService({}, {});
  await assert.rejects(() => service.loginWithGoogle(''), /idToken is required/);
});

test('IdentityService: enrollInOrganization creates a new enrollment for a known end user', async () => {
  const mockRepo = {
    findEndUserById: async (id) => ({ id, suiAddress: '0xabc' }),
    findEnrollment: async () => null,
    enroll: async (params) => ({ id: 'org-end-user-1', ...params }),
  };

  const service = new IdentityService(mockRepo, {});
  const result = await service.enrollInOrganization({ endUserId: 'end-user-1', organizationId: 'org-1' });

  assert.equal(result.organizationEndUserId, 'org-end-user-1');
  assert.equal(result.isNewEnrollment, true);
});

test('IdentityService: enrollInOrganization is idempotent for an existing enrollment', async () => {
  const mockRepo = {
    findEndUserById: async (id) => ({ id, suiAddress: '0xabc' }),
    findEnrollment: async () => ({ id: 'org-end-user-1' }),
    enroll: async () => {
      throw new Error('should not enroll twice');
    },
  };

  const service = new IdentityService(mockRepo, {});
  const result = await service.enrollInOrganization({ endUserId: 'end-user-1', organizationId: 'org-1' });

  assert.equal(result.organizationEndUserId, 'org-end-user-1');
  assert.equal(result.isNewEnrollment, false);
});

test('IdentityService: enrollInOrganization rejects an unknown end user', async () => {
  const mockRepo = { findEndUserById: async () => null };
  const service = new IdentityService(mockRepo, {});
  await assert.rejects(
    () => service.enrollInOrganization({ endUserId: 'ghost', organizationId: 'org-1' }),
    /No end user ghost/,
  );
});

test('SponsoredTransactionService: previewSponsoredRedeem builds the kind and sponsors with exactly one allowed target', async () => {
  let sponsoredArgs = null;
  const mockEnoki = {
    createSponsoredTransaction: async (params) => {
      sponsoredArgs = params;
      return { bytes: 'full-tx-bytes', digest: 'digest-1' };
    },
  };
  const mockBuilder = {
    redeemMoveCallTarget: '0xpkg::credit_account::redeem',
    buildRedeemTransactionKind: async (params) => {
      assert.equal(params.accountId, 'account-1');
      assert.equal(params.cost, 50n);
      return new Uint8Array([1, 2, 3]);
    },
  };

  const service = new SponsoredTransactionService(mockEnoki, mockBuilder);
  const result = await service.previewSponsoredRedeem({
    beneficiaryAddress: '0xbeneficiary',
    accountId: 'account-1',
    cost: 50n,
    reference: new Uint8Array([9]),
  });

  assert.equal(result.transactionBytes, 'full-tx-bytes');
  assert.equal(result.digest, 'digest-1');
  assert.equal(sponsoredArgs.sender, '0xbeneficiary');
  assert.deepEqual(sponsoredArgs.allowedMoveCallTargets, ['0xpkg::credit_account::redeem']);
  assert.deepEqual(Array.from(sponsoredArgs.transactionKindBytes), [1, 2, 3]);
});

test('SponsoredTransactionService: there is no parameter that can widen the sponsorship allowlist', async () => {
  const mockEnoki = {
    createSponsoredTransaction: async (params) => {
      assert.deepEqual(params.allowedMoveCallTargets, ['0xpkg::credit_account::redeem']);
      return { bytes: 'bytes', digest: 'digest' };
    },
  };
  const mockBuilder = {
    redeemMoveCallTarget: '0xpkg::credit_account::redeem',
    buildRedeemTransactionKind: async () => new Uint8Array([]),
  };

  // `previewSponsoredRedeem`'s only parameters are domain values (account id, cost, reference) —
  // there is no "target" argument anywhere on this class that a caller could use to sponsor
  // anything other than `credit_account::redeem`.
  const service = new SponsoredTransactionService(mockEnoki, mockBuilder);
  await service.previewSponsoredRedeem({
    beneficiaryAddress: '0xbeneficiary',
    accountId: 'account-99',
    cost: 1n,
    reference: new Uint8Array([]),
  });
});

import { PosRedemptionService } from '../api/dist/domain/credits/pos-redemption.service.js';
import { OperationPayloadConflictError } from '../api/dist/infra/db/repositories/operations.repository.js';

function mockRedis() {
  const store = new Map();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      store.delete(key);
      return 1;
    },
  };
}

test('PosRedemptionService: reserve builds, sponsors, and caches a new hold', async () => {
  const redis = mockRedis();
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
    reservePosRedemption: async (params) => ({
      transaction: { id: 'tx-1', status: 'PENDING', idempotencyKey: params.idempotencyKey },
      accountId: 'account-1',
      isNew: true,
    }),
    findBeneficiaryAddress: async () => '0xbeneficiary',
  };
  let sponsoredArgs = null;
  const mockSponsoredTx = {
    previewSponsoredRedeem: async (params) => {
      sponsoredArgs = params;
      return { transactionBytes: 'bytes-1', digest: 'digest-1' };
    },
  };

  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, {}, {});
  const result = await service.reserve('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(result.digest, 'digest-1');
  assert.equal(result.transactionBytes, 'bytes-1');
  assert.equal(result.status, 'PENDING');
  assert.equal(sponsoredArgs.beneficiaryAddress, '0xbeneficiary');
  assert.equal(sponsoredArgs.accountId, 'account-1');
  assert.equal(sponsoredArgs.cost, 50n);
  assert.equal(await redis.get('pos-redeem:reserve:digest-1') !== null, true);
  assert.equal(await redis.get('pos-redeem:idem:org-1:idem-1'), 'digest-1');
});

test('PosRedemptionService: reserve rejects a member from another organization', async () => {
  const service = new PosRedemptionService(mockRedis(), { findMemberOrganizationId: async () => 'org-2' }, {}, {}, {});
  await assert.rejects(
    () => service.reserve('org-1', { organizationEndUserId: 'user-1', pointsAmount: 10, idempotencyKey: 'idem-1' }),
    /was not found for this organization/,
  );
});

test('PosRedemptionService: reserve maps a payload conflict to a 409', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
    reservePosRedemption: async () => {
      throw new OperationPayloadConflictError('idem-1');
    },
  };
  const service = new PosRedemptionService(mockRedis(), mockCreditsRepo, {}, {}, {});
  await assert.rejects(
    () => service.reserve('org-1', { organizationEndUserId: 'user-1', pointsAmount: 10, idempotencyKey: 'idem-1' }),
    (err) => err.constructor.name === 'ConflictException',
  );
});

test('PosRedemptionService: reserve replays cached bytes instead of sponsoring twice', async () => {
  const redis = mockRedis();
  await redis.set('pos-redeem:idem:org-1:idem-1', 'digest-cached');
  await redis.set(
    'pos-redeem:reserve:digest-cached',
    JSON.stringify({
      organizationId: 'org-1',
      organizationEndUserId: 'user-1',
      loyaltyTransactionId: 'tx-1',
      pointsAmount: 50,
      transactionBytes: 'bytes-cached',
    }),
  );
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
    reservePosRedemption: async () => ({
      transaction: { id: 'tx-1', status: 'PENDING', idempotencyKey: 'idem-1' },
      accountId: 'account-1',
      isNew: false,
    }),
  };
  let sponsorCalled = false;
  const mockSponsoredTx = { previewSponsoredRedeem: async () => (sponsorCalled = true) };

  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, {}, {});
  const result = await service.reserve('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(result.digest, 'digest-cached');
  assert.equal(result.transactionBytes, 'bytes-cached');
  assert.equal(sponsorCalled, false);
});

test('PosRedemptionService: reserve re-sponsors when the cache lapsed on a retry of an existing hold', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
    reservePosRedemption: async () => ({
      transaction: { id: 'tx-1', status: 'PENDING', idempotencyKey: 'idem-1' },
      accountId: 'account-1',
      isNew: false,
    }),
    findBeneficiaryAddress: async () => '0xbeneficiary',
  };
  let sponsorCalled = false;
  const mockSponsoredTx = {
    previewSponsoredRedeem: async () => {
      sponsorCalled = true;
      return { transactionBytes: 'bytes-fresh', digest: 'digest-fresh' };
    },
  };

  const service = new PosRedemptionService(mockRedis(), mockCreditsRepo, mockSponsoredTx, {}, {});
  const result = await service.reserve('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(sponsorCalled, true);
  assert.equal(result.digest, 'digest-fresh');
});

test('PosRedemptionService: reserve on an already-settled idempotency key returns the final state without touching chain', async () => {
  const mockCreditsRepo = {
    findMemberOrganizationId: async () => 'org-1',
    reservePosRedemption: async () => ({
      transaction: { id: 'tx-1', status: 'CONFIRMED', idempotencyKey: 'idem-1' },
      accountId: 'account-1',
      isNew: false,
    }),
  };
  let sponsorCalled = false;
  const mockSponsoredTx = { previewSponsoredRedeem: async () => (sponsorCalled = true) };

  const service = new PosRedemptionService(mockRedis(), mockCreditsRepo, mockSponsoredTx, {}, {});
  const result = await service.reserve('org-1', {
    organizationEndUserId: 'user-1',
    pointsAmount: 50,
    idempotencyKey: 'idem-1',
  });

  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.digest, null);
  assert.equal(result.transactionBytes, null);
  assert.equal(sponsorCalled, false);
});

test('PosRedemptionService: finalize confirms on-chain success and emits a webhook', async () => {
  const redis = mockRedis();
  await redis.set(
    'pos-redeem:reserve:digest-1',
    JSON.stringify({
      organizationId: 'org-1',
      organizationEndUserId: 'user-1',
      loyaltyTransactionId: 'tx-1',
      pointsAmount: 50,
      transactionBytes: 'bytes-1',
    }),
  );
  const mockSponsoredTx = { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) };
  const mockSuiBuilder = { waitForTransaction: async () => ({ status: 'success', events: [] }) };
  let confirmArgs = null;
  const mockCreditsRepo = {
    findBeneficiaryAddress: async () => '0xbeneficiary',
    confirmPosRedemptionOnChain: async (params) => {
      confirmArgs = params;
      return { id: 'btx-1', digest: params.digest };
    },
    getOrCreateCreditOwnership: async () => ({ confirmedBalance: 150 }),
  };
  let emitted = null;
  const mockWebhooks = { emit: async (organizationId, eventType, payload) => (emitted = { organizationId, eventType, payload }) };

  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, mockSuiBuilder, mockWebhooks);
  const result = await service.finalize({ digest: 'digest-1', signature: 'sig-1' });

  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.newBalance, 150);
  assert.equal(result.pointsRedeemed, 50);
  assert.equal(confirmArgs.sender, '0xbeneficiary');
  assert.equal(emitted.eventType, 'credits.redeemed');
  assert.equal(await redis.get('pos-redeem:reserve:digest-1'), null);
});

test('PosRedemptionService: finalize rejects an unknown or expired digest', async () => {
  const service = new PosRedemptionService(mockRedis(), {}, {}, {}, {});
  await assert.rejects(
    () => service.finalize({ digest: 'ghost-digest', signature: 'sig-1' }),
    /expired/,
  );
});

test('PosRedemptionService: finalize leaves the reservation intact when Enoki execute fails', async () => {
  const redis = mockRedis();
  await redis.set('pos-redeem:reserve:digest-1', JSON.stringify({ organizationId: 'org-1', organizationEndUserId: 'user-1', loyaltyTransactionId: 'tx-1', pointsAmount: 50, transactionBytes: 'bytes-1' }));
  const mockSponsoredTx = {
    executeSponsoredRedeem: async () => {
      throw new Error('signature expired');
    },
  };

  const service = new PosRedemptionService(redis, { findBeneficiaryAddress: async () => '0xbeneficiary' }, mockSponsoredTx, {}, {});
  await assert.rejects(() => service.finalize({ digest: 'digest-1', signature: 'bad-sig' }), /signature expired/);
  assert.notEqual(await redis.get('pos-redeem:reserve:digest-1'), null);
});

test('PosRedemptionService: finalize releases the hold on a definitive on-chain failure', async () => {
  const redis = mockRedis();
  await redis.set('pos-redeem:reserve:digest-1', JSON.stringify({ organizationId: 'org-1', organizationEndUserId: 'user-1', loyaltyTransactionId: 'tx-1', pointsAmount: 50, transactionBytes: 'bytes-1' }));
  const mockSponsoredTx = { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) };
  const mockSuiBuilder = { waitForTransaction: async () => ({ status: 'failure', errorMessage: 'EInsufficientBalance' }) };
  let failArgs = null;
  const mockCreditsRepo = {
    findBeneficiaryAddress: async () => '0xbeneficiary',
    failPosRedemptionOnChain: async (params) => {
      failArgs = params;
    },
  };

  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, mockSuiBuilder, {});
  await assert.rejects(
    () => service.finalize({ digest: 'digest-1', signature: 'sig-1' }),
    /EInsufficientBalance/,
  );
  assert.equal(failArgs.loyaltyTransactionId, 'tx-1');
  assert.equal(await redis.get('pos-redeem:reserve:digest-1'), null);
});


function cachedReserveRedis() {
  const redis = mockRedis();
  return redis
    .set(
      'pos-redeem:reserve:digest-1',
      JSON.stringify({
        organizationId: 'org-1',
        organizationEndUserId: 'user-1',
        loyaltyTransactionId: 'tx-1',
        pointsAmount: 50,
        transactionBytes: 'bytes-1',
      }),
    )
    .then(() => redis);
}

test('PosRedemptionService: finalize with no beneficiary address fails before executing anything', async () => {
  const redis = await cachedReserveRedis();
  const mockSponsoredTx = { executeSponsoredRedeem: async () => assert.fail('must not execute') };
  const mockCreditsRepo = { findBeneficiaryAddress: async () => null };
  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, {}, {});
  await assert.rejects(service.finalize({ digest: 'digest-1', signature: 'sig-1' }), /No real Sui address/);
});

test('PosRedemptionService: a concurrent finalize of the same digest answers CONFIRMED, not a 500', async () => {
  const redis = await cachedReserveRedis();
  const mockSponsoredTx = { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) };
  const mockSuiBuilder = { waitForTransaction: async () => ({ status: 'success', digest: 'digest-1', events: [] }) };
  const mockCreditsRepo = {
    findBeneficiaryAddress: async () => '0xbeneficiary',
    confirmPosRedemptionOnChain: async () => {
      throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    },
    getOrCreateCreditOwnership: async () => ({ confirmedBalance: 100 }),
  };
  const mockWebhooks = { emit: async () => assert.fail('the first finalize owns the webhook') };
  const service = new PosRedemptionService(redis, mockCreditsRepo, mockSponsoredTx, mockSuiBuilder, mockWebhooks);

  const result = await service.finalize({ digest: 'digest-1', signature: 'sig-1' });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.blockchainDigest, 'digest-1');
  assert.equal(result.newBalance, 100);
});

import { ProgramsService } from '../api/dist/domain/programs/programs.service.js';

const PROVISION_PARAMS = {
  organizationId: 'org-1',
  earnBps: 100,
  expiryMs: 2_592_000_000,
  issuerRecipient: '0xissuer',
  shardCount: 2,
  totalBudget: 1_000_000,
};

const PROVISIONED = {
  programId: '0xprogram',
  adminCapId: '0xadmincap',
  policyVersionId: '0xpolicy',
  issuerCapId: '0xissuercap',
  operationShardIds: ['0xop0', '0xop1'],
  budgetShardIds: ['0xbudget0', '0xbudget1'],
};

test('ProgramsService: reserves the organization before minting, then activates the row with the on-chain ids', async () => {
  const calls = [];
  const mockRepo = {
    reserve: async (params) => {
      calls.push('reserve');
      assert.equal(params.organizationId, 'org-1');
      assert.equal(params.policyVersion, 1);
      assert.equal(params.shardCount, 2);
      assert.equal(params.totalBudget, 1_000_000);
      return { id: 'program-row-1', ...params, status: 'PROVISIONING' };
    },
    activate: async (id, chainIds) => {
      calls.push('activate');
      assert.equal(id, 'program-row-1');
      return { id, status: 'ACTIVE', ...chainIds };
    },
  };
  const mockAdmin = {
    provisionProgram: async (params) => {
      calls.push('provisionProgram');
      assert.equal(params.earnBps, 100);
      assert.equal(params.expiryMs, 2_592_000_000);
      assert.equal(params.issuerRecipient, '0xissuer');
      assert.equal(params.shardCount, 2);
      assert.equal(params.totalBudget, 1_000_000);
      return PROVISIONED;
    },
  };

  const service = new ProgramsService(mockRepo, mockAdmin);
  const result = await service.provisionForOrganization(PROVISION_PARAMS);

  assert.deepEqual(calls, ['reserve', 'provisionProgram', 'activate']);
  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.programControlId, '0xprogram');
  assert.equal(result.issuerCapId, '0xissuercap');
  assert.deepEqual(result.operationShardIds, ['0xop0', '0xop1']);
  assert.deepEqual(result.budgetShardIds, ['0xbudget0', '0xbudget1']);
});

test('ProgramsService: a losing concurrent reservation is a ConflictException and never touches the chain', async () => {
  let adminCalled = false;
  const mockRepo = {
    reserve: async () => {
      // drizzle wraps the postgres-js error; the unique_violation code lives on `cause`
      throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    },
  };
  const mockAdmin = {
    provisionProgram: async () => {
      adminCalled = true;
      throw new Error('should not provision a second program on-chain');
    },
  };

  const service = new ProgramsService(mockRepo, mockAdmin);
  await assert.rejects(() => service.provisionForOrganization(PROVISION_PARAMS), (err) => {
    assert.equal(err.name, 'ConflictException');
    assert.match(err.message, /already has a program/);
    return true;
  });
  assert.equal(adminCalled, false);
});

test('ProgramsService: a non-unique reservation failure is rethrown as-is, not mapped to a conflict', async () => {
  const mockRepo = {
    reserve: async () => {
      throw new Error('connection reset');
    },
  };
  const service = new ProgramsService(mockRepo, {});
  await assert.rejects(() => service.provisionForOrganization(PROVISION_PARAMS), /connection reset/);
});

test('ProgramsService: an on-chain failure releases the reservation so the organization can retry', async () => {
  let releasedId = null;
  const mockRepo = {
    reserve: async (params) => ({ id: 'program-row-1', ...params }),
    release: async (id) => {
      releasedId = id;
    },
  };
  const mockAdmin = {
    provisionProgram: async () => {
      throw new Error('create_program failed on-chain');
    },
  };

  const service = new ProgramsService(mockRepo, mockAdmin);
  await assert.rejects(() => service.provisionForOrganization(PROVISION_PARAMS), /create_program failed/);
  assert.equal(releasedId, 'program-row-1');
});

test('ProgramsService: a DB failure after minting keeps the reservation, blocking a duplicate mint', async () => {
  let released = false;
  const mockRepo = {
    reserve: async (params) => ({ id: 'program-row-1', ...params }),
    activate: async () => {
      throw new Error('connection reset');
    },
    release: async () => {
      released = true;
    },
  };
  const mockAdmin = { provisionProgram: async () => PROVISIONED };

  const service = new ProgramsService(mockRepo, mockAdmin);
  await assert.rejects(() => service.provisionForOrganization(PROVISION_PARAMS), /connection reset/);
  assert.equal(released, false);
});

import { ProgramAdminClient } from '../api/dist/infra/clients/sui/program-admin.client.js';

test('ProgramAdminClient: rejects bad shard inputs before sending any transaction', async () => {
  const admin = new ProgramAdminClient();
  // Any chain access would need SUI_PROGRAM_ADMIN_PRIVATE_KEY; these must fail before reaching it.
  const base = { earnBps: 100, expiryMs: 2_592_000_000, issuerRecipient: '0xissuer' };
  await assert.rejects(() => admin.provisionProgram({ ...base, shardCount: 0, totalBudget: 1 }), /shardCount/);
  await assert.rejects(() => admin.provisionProgram({ ...base, shardCount: 1.5, totalBudget: 1 }), /shardCount/);
  await assert.rejects(() => admin.provisionProgram({ ...base, shardCount: 1, totalBudget: -1 }), /totalBudget/);
});

import { operationShardIndex } from '../ts-sdks/packages/chain/dist/index.js';
import { selectShards } from '../api/dist/infra/clients/sui/sui.client.js';

// Same key/count -> index fixtures as `shard_index_matches_shared_fixture` and
// `budget_shards_are_debited_independently` in contracts/sui/tests/credit_account_tests.move:
// if either side's routing changes, one of the two suites breaks.
const SHARD_INDEX_FIXTURES = [
  ['earn:fixture-shard-key', 7, 4],
  ['op-1', 16, 5],
  ['op-5', 1, 0],
  ['op-1', 2, 1],
  ['op-4', 2, 0],
];

test('operationShardIndex: matches the Move side on shared fixtures', () => {
  for (const [key, shardCount, expected] of SHARD_INDEX_FIXTURES) {
    assert.equal(operationShardIndex(Buffer.from(key), shardCount), expected, `${key} mod ${shardCount}`);
  }
});

test('operationShardIndex: rejects a non-positive shard count', () => {
  assert.throws(() => operationShardIndex(Buffer.from('op-1'), 0), /positive integer/);
});

test('selectShards: picks the operation and budget shard at the key-owned index', () => {
  const config = { operationShardIds: ['0xop0', '0xop1'], budgetShardIds: ['0xbudget0', '0xbudget1'] };
  assert.deepEqual(selectShards(config, Buffer.from('op-1')), {
    operationShardId: '0xop1',
    budgetShardId: '0xbudget1',
  });
  assert.deepEqual(selectShards(config, Buffer.from('op-4')), {
    operationShardId: '0xop0',
    budgetShardId: '0xbudget0',
  });
});

test('selectShards: rejects a program with no shards or mismatched shard counts', () => {
  const key = Buffer.from('op-1');
  assert.throws(() => selectShards({ operationShardIds: [], budgetShardIds: [] }, key), /same non-zero count/);
  assert.throws(
    () => selectShards({ operationShardIds: ['0xop0'], budgetShardIds: ['0xb0', '0xb1'] }, key),
    /same non-zero count/,
  );
});

import { acceptCommand, hashPayload } from '../api/dist/infra/db/repositories/operations.repository.js';

function fakeCommandTx(existing) {
  const updates = [];
  const tx = {
    query: { operations: { findFirst: async () => existing } },
    update: () => ({
      set: (values) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            return [{ ...existing, ...values }];
          },
        }),
      }),
    }),
  };
  return { tx, updates };
}

test('acceptCommand: the payload hash ignores key order, so a rebuilt-but-identical payload is a replay', async () => {
  assert.equal(hashPayload({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }), hashPayload({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));

  const existing = { id: 'op-1', payloadHash: hashPayload({ amount: 10, member: 'm1' }) };
  const { tx } = fakeCommandTx(existing);
  const result = await acceptCommand(tx, {
    tenantId: 't1',
    idempotencyKey: 'k1',
    commandType: 'X',
    payload: { member: 'm1', amount: 10 },
  });
  assert.equal(result.isNew, false);

  await assert.rejects(
    acceptCommand(tx, { tenantId: 't1', idempotencyKey: 'k1', commandType: 'X', payload: { member: 'm1', amount: 11 } }),
    OperationPayloadConflictError,
  );
});

test('acceptCommand: a row accepted before payload hashes existed adopts the hash instead of conflicting', async () => {
  const { tx, updates } = fakeCommandTx({ id: 'op-legacy', payloadHash: null });
  const result = await acceptCommand(tx, { tenantId: 't1', idempotencyKey: 'k1', commandType: 'X', payload: { amount: 10 } });
  assert.equal(result.isNew, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payloadHash, hashPayload({ amount: 10 }));
});
