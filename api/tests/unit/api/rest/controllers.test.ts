import { describe, expect, it, vi } from 'vitest';
import { CreditsController } from '#api/rest/credits.controller.js';
import { RewardsController } from '#api/rest/rewards.controller.js';
import { CustomerVerificationController, IdentityController } from '#api/rest/identity.controller.js';
import { WebhooksController } from '#api/rest/webhooks.controller.js';
import { ApiCredentialsController } from '#api/rest/api-credentials.controller.js';
import type { CreditsService } from '#domain/credits/credits.service.js';
import type { EarnService } from '#domain/credits/earn.service.js';
import type { ReversalService } from '#domain/credits/reversal.service.js';
import type { PosRedemptionService } from '#domain/credits/pos-redemption.service.js';
import type { RewardsService } from '#domain/rewards/rewards.service.js';
import type { RefundPolicyService } from '#domain/rewards/refund-policy.service.js';
import type { IdentityService } from '#domain/identity/identity.service.js';
import type { WebhookEndpointsService } from '#domain/webhooks/webhook-endpoints.service.js';
import type { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import type { ApiCredentialsService } from '#infra/auth/api-credentials.service.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { stub } from '../../../helpers/stub.js';

const tenant: TenantContext = { organizationId: 'org-1', credentialId: 'cred-1', scopes: ['read', 'write', 'admin'] };
const ok = <T>(value: T) => vi.fn(async () => value);
const bad = (promise: Promise<unknown>, message: RegExp) =>
  expect(promise).rejects.toMatchObject({ name: 'BadRequestException', message: expect.stringMatching(message) });

/**
 * Controllers only validate required fields and delegate with the tenant's organization id —
 * routing, guards, and serialization are covered end-to-end in tests/integration/http.
 */
describe('CreditsController', () => {
  function controller(overrides: {
    credits?: Partial<Record<keyof CreditsService, unknown>>;
    earn?: Partial<Record<keyof EarnService, unknown>>;
    reversal?: Partial<Record<keyof ReversalService, unknown>>;
    pos?: Partial<Record<keyof PosRedemptionService, unknown>>;
  }) {
    return new CreditsController(
      stub<CreditsService>(overrides.credits),
      stub<EarnService>(overrides.earn),
      stub<ReversalService>(overrides.reversal),
      stub<PosRedemptionService>(overrides.pos),
    );
  }
  const body = { organizationEndUserId: 'user-1', pointsAmount: 10, idempotencyKey: 'k' };

  it('earn and reserve validate their separate amount contracts', async () => {
    const executeEarn = ok({ transactionId: 'e' });
    const reserve = ok({ transactionId: 'p' });
    const c = controller({ earn: { executeEarn }, pos: { reserve } });
    const earnBody = { organizationEndUserId: 'user-1', purchaseAmount: 100000, idempotencyKey: 'k' };
    expect(await c.earn(tenant, earnBody)).toEqual({ transactionId: 'e' });
    expect(executeEarn).toHaveBeenCalledWith('org-1', earnBody);
    expect(await c.reservePosRedemption(tenant, body)).toEqual({ transactionId: 'p' });
    for (const missing of ['organizationEndUserId', 'purchaseAmount', 'idempotencyKey'] as const) {
      await bad(c.earn(tenant, { ...earnBody, [missing]: undefined } as unknown as typeof earnBody), /are required/);
    }
    for (const missing of ['organizationEndUserId', 'pointsAmount', 'idempotencyKey'] as const) {
      await bad(
        c.reservePosRedemption(tenant, { ...body, [missing]: undefined } as unknown as typeof body),
        /are required/,
      );
    }
  });

  it('finalize needs a digest and signature and is not tenant-scoped', async () => {
    const finalize = ok({ status: 'CONFIRMED' });
    const c = controller({ pos: { finalize } });

    expect(await c.finalizePosRedemption({ digest: 'd', signature: 's' })).toEqual({ status: 'CONFIRMED' });
    expect(finalize).toHaveBeenCalledWith({ digest: 'd', signature: 's' });
    await bad(c.finalizePosRedemption({ digest: '', signature: 's' }), /digest and signature are required/);
    await bad(c.finalizePosRedemption({ digest: 'd', signature: '' }), /digest and signature are required/);
  });

  it('reverse merges the path id into the request and requires key + reason', async () => {
    const reverseTransaction = ok({ reversalTransactionId: 'rv' });
    const c = controller({ reversal: { reverseTransaction } });

    await c.reverseTransaction(tenant, 'tx-1', { idempotencyKey: 'k', reason: 'chargeback' });
    expect(reverseTransaction).toHaveBeenCalledWith(
      'org-1',
      {
        transactionId: 'tx-1',
        idempotencyKey: 'k',
        reason: 'chargeback',
      },
      tenant,
    );
    const withForgedId = { idempotencyKey: 'k', reason: 'chargeback', transactionId: 'tx-other' };
    await c.reverseTransaction(tenant, 'tx-1', withForgedId);
    expect(reverseTransaction).toHaveBeenLastCalledWith('org-1', { ...withForgedId, transactionId: 'tx-1' }, tenant);
    await bad(
      c.reverseTransaction(tenant, 'tx-1', { idempotencyKey: '', reason: 'x' }),
      /idempotencyKey and reason are required/,
    );
    await bad(
      c.reverseTransaction(tenant, 'tx-1', { idempotencyKey: 'k', reason: '' }),
      /idempotencyKey and reason are required/,
    );
  });

  it('balance and transactions read through CreditsService, parsing the limit', async () => {
    const getBalance = ok({ confirmedBalance: 1 });
    const listTransactions = ok([]);
    const c = controller({ credits: { getBalance, listTransactions } });

    await c.getBalance(tenant, 'user-1');
    await c.getTransactions(tenant, 'user-1', '10');
    await c.getTransactions(tenant, 'user-1');
    expect(getBalance).toHaveBeenCalledWith('org-1', 'user-1', undefined);
    expect(listTransactions.mock.calls).toEqual([
      ['org-1', 'user-1', 10],
      ['org-1', 'user-1', 50],
    ]);
  });
});

describe('RewardsController', () => {
  it('validates required fields and delegates every route with the tenant org', async () => {
    const service = {
      createVoucher: ok({ id: 'v-1' }),
      listVouchers: ok([]),
      getVoucher: ok({ id: 'v-1' }),
      claimVoucher: ok({ serialCode: 's' }),
      redeemVoucher: ok({ status: 'REDEEMED' }),
      listMemberVouchers: ok([]),
    };
    const c = new RewardsController(stub<RewardsService>(service), stub<RefundPolicyService>({}));
    const voucher = { code: 'C', title: 'T', discountType: 'PERCENTAGE' as const };

    await c.createVoucher(tenant, voucher);
    await c.listVouchers(tenant);
    await c.getVoucher(tenant, 'v-1');
    await c.claimVoucher(tenant, 'v-1', { organizationEndUserId: 'user-1' });
    await c.redeemVoucher(tenant, { serialCode: 's' });
    await c.listMemberVouchers(tenant, 'user-1');

    expect(service.createVoucher).toHaveBeenCalledWith('org-1', voucher);
    expect(service.listVouchers).toHaveBeenCalledWith('org-1');
    expect(service.getVoucher).toHaveBeenCalledWith('org-1', 'v-1');
    expect(service.claimVoucher).toHaveBeenCalledWith('org-1', 'v-1', { organizationEndUserId: 'user-1' });
    expect(service.redeemVoucher).toHaveBeenCalledWith('org-1', { serialCode: 's' });
    expect(service.listMemberVouchers).toHaveBeenCalledWith('org-1', 'user-1');

    for (const missing of ['code', 'title', 'discountType'] as const) {
      await bad(c.createVoucher(tenant, { ...voucher, [missing]: '' }), /code, title, and discountType are required/);
    }
    await bad(c.claimVoucher(tenant, 'v-1', { organizationEndUserId: '' }), /organizationEndUserId is required/);
    await bad(c.redeemVoucher(tenant, { serialCode: '' }), /serialCode is required/);
  });
});

describe('IdentityController', () => {
  it('validates required fields and maps the enroll path parameter', async () => {
    const service = {
      loginWithGoogle: ok({ endUserId: 'eu' }),
      enrollInOrganization: ok({ organizationEndUserId: 'oeu' }),
      createZkLoginNonce: ok({ nonce: 'n' }),
      createZkLoginProof: ok({ proofPoints: {} }),
    };
    const c = new IdentityController(stub<IdentityService>(service));

    await c.googleLogin({ idToken: 'jwt' });
    await c.enroll('org-1', { idToken: 'jwt' });
    await c.createNonce({ ephemeralPublicKey: 'epk' });
    await c.createProof({ idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 1 });

    expect(service.loginWithGoogle).toHaveBeenCalledWith('jwt');
    expect(service.enrollInOrganization).toHaveBeenCalledWith({
      idToken: 'jwt',
      organizationId: 'org-1',
    });
    expect(service.createZkLoginNonce).toHaveBeenCalledWith({ ephemeralPublicKey: 'epk' });
    expect(service.createZkLoginProof).toHaveBeenCalledWith({
      idToken: 'jwt',
      ephemeralPublicKey: 'epk',
      randomness: 'r',
      maxEpoch: 1,
    });

    await bad(c.googleLogin({ idToken: '' }), /idToken is required/);
    await bad(c.enroll('org-1', { idToken: '' }), /idToken is required/);
    await bad(c.enroll('org-1', { endUserId: 'eu' } as never), /idToken is required/);
    await bad(c.googleLogin({ idToken: 42 } as never), /idToken is required/);
    await bad(c.googleLogin(undefined as never), /idToken is required/);
  });
});

describe('CustomerVerificationController', () => {
  it('takes the organization from the credential, never the body', async () => {
    const service = { verifyCustomer: ok({ memberId: 'm' }) };
    const c = new CustomerVerificationController(stub<IdentityService>(service));

    await c.verify({ ...tenant, organizationId: 'org-from-key' }, {
      idToken: 'jwt',
      organizationId: 'org-from-body',
    } as never);

    expect(service.verifyCustomer).toHaveBeenCalledWith('jwt', 'org-from-key');
    await bad(c.verify(tenant, { idToken: '' }), /idToken is required/);
  });
});

describe('WebhooksController', () => {
  it('validates the endpoint URL and delegates every route with the tenant org', async () => {
    const endpoints = { register: ok({}), list: ok([]), disable: ok({}), enable: ok({}), rotateSecret: ok({}) };
    const deliveries = { list: ok([]), replay: ok({}) };
    const c = new WebhooksController(
      stub<WebhookEndpointsService>(endpoints),
      stub<WebhookDeliveryService>(deliveries),
    );

    await c.registerEndpoint(tenant, { url: 'https://x', description: 'd' });
    await c.listEndpoints(tenant);
    await c.disableEndpoint(tenant, 'ep-1');
    await c.enableEndpoint(tenant, 'ep-1');
    await c.rotateSecret(tenant, 'ep-1');
    await c.listDeliveries(tenant);
    await c.replayDelivery(tenant, 'dlv-1');

    expect(endpoints.register).toHaveBeenCalledWith('org-1', 'https://x', 'd');
    expect(endpoints.list).toHaveBeenCalledWith('org-1');
    expect(endpoints.disable).toHaveBeenCalledWith('org-1', 'ep-1');
    expect(endpoints.enable).toHaveBeenCalledWith('org-1', 'ep-1');
    expect(endpoints.rotateSecret).toHaveBeenCalledWith('org-1', 'ep-1');
    expect(deliveries.list).toHaveBeenCalledWith('org-1');
    expect(deliveries.replay).toHaveBeenCalledWith('org-1', 'dlv-1');
    await bad(c.registerEndpoint(tenant, { url: '' }), /url is required/);
  });
});

describe('ApiCredentialsController', () => {
  it('returns the raw key only on issue/rotate, alongside the stored credential', async () => {
    const service = {
      list: ok([{ id: 'c1' }]),
      issue: ok({ credential: { id: 'c2', keyHash: 'h' }, rawKey: 'octap_live_raw' }),
      revoke: ok({ id: 'c1', status: 'REVOKED' }),
      rotate: ok({ credential: { id: 'c3' }, rawKey: 'octap_live_new' }),
    };
    const c = new ApiCredentialsController(stub<ApiCredentialsService>(service));

    expect(await c.list(tenant)).toEqual([{ id: 'c1' }]);
    expect(await c.issue(tenant, { name: 'pos', scopes: ['read'] })).toEqual({
      id: 'c2',
      keyHash: 'h',
      rawKey: 'octap_live_raw',
    });
    expect(await c.revoke(tenant, 'c1')).toEqual({ id: 'c1', status: 'REVOKED' });
    expect(await c.rotate(tenant, 'c1')).toEqual({ id: 'c3', rawKey: 'octap_live_new' });
    expect(service.issue).toHaveBeenCalledWith('org-1', 'pos', ['read']);
    expect(service.revoke).toHaveBeenCalledWith('org-1', 'c1');
    expect(service.rotate).toHaveBeenCalledWith('org-1', 'c1');
  });
});
