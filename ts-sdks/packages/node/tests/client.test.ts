import { describe, expect, it, vi } from 'vitest';
import { OctaApiError, OctaPointClient, OctaSdkError, createOctaPointClient } from '../src/index.js';

const jsonHeaders = { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) };
const textHeaders = { get: () => 'text/plain' };

/** A fetch double that records every call and answers with `respond(url, init)`. */
function recordingFetch(respond: (url: string, init: RequestInit) => unknown = () => ({})) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => respond(String(url), init) };
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch, last: () => calls[calls.length - 1] };
}

describe('OctaPointClient', () => {
  it('verifyCustomer posts the token with the API key and returns the verified customer', async () => {
    const customer = { endUserId: 'eu-1', suiAddress: '0xabc', memberId: null };
    const { fetchFn, last } = recordingFetch(() => customer);
    const client = createOctaPointClient({ credentials: { apiKey: 'test-key' }, fetchFn });

    await expect(client.verifyCustomer('google-jwt')).resolves.toEqual(customer);

    expect(last()).toMatchObject({
      method: 'POST',
      url: 'http://localhost:3000/v1/identity/verify',
      body: { idToken: 'google-jwt' },
      headers: { authorization: 'Bearer test-key' },
    });
  });

  it('updates voucher lifecycle fields through the authenticated public PATCH method', async () => {
    const { fetchFn, last } = recordingFetch(() => ({ id: 'voucher-1', status: 'PAUSED' }));
    const client = createOctaPointClient({ credentials: { apiKey: 'test-key' }, organizationId: 'org-1', fetchFn });
    const voucher = await client.updateVoucher('voucher-1', { status: 'PAUSED', totalSupply: null });
    expect(voucher.status).toBe('PAUSED');
    expect(last()).toMatchObject({
      method: 'PATCH',
      url: 'http://localhost:3000/v1/rewards/vouchers/voucher-1',
      body: { status: 'PAUSED', totalSupply: null },
      headers: { authorization: 'Bearer test-key', 'x-organization-id': 'org-1' },
    });
  });
  it('earnPoints and redeemPoints send authenticated JSON requests, with a per-call org override', async () => {
    const { fetchFn, last } = recordingFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      return { transactionId: 'tx-sdk-1', pointsEarned: body.pointsAmount, newBalance: 200 };
    });
    const client = createOctaPointClient({
      baseUrl: 'https://api.octap.network/',
      organizationId: 'org-123',
      credentials: { apiKey: 'secret-key-xyz' },
      fetchFn,
    });

    const earn = await client.earnPoints({
      organizationEndUserId: 'user-456',
      pointsAmount: 100,
      idempotencyKey: 'idem-key-1',
    });

    expect(last()).toEqual({
      url: 'https://api.octap.network/v1/credits/earn',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer secret-key-xyz',
        'x-organization-id': 'org-123',
      },
      body: { organizationEndUserId: 'user-456', pointsAmount: 100, idempotencyKey: 'idem-key-1' },
    });
    expect(earn).toMatchObject({ transactionId: 'tx-sdk-1', newBalance: 200 });

    await client.redeemPoints(
      { organizationEndUserId: 'user-456', pointsAmount: 50, idempotencyKey: 'idem-key-2' },
      { organizationId: 'org-override' },
    );
    expect(last().url).toBe('https://api.octap.network/v1/credits/redeem');
    expect(last().headers['x-organization-id']).toBe('org-override');
  });

  it('getBalance and listTransactions query the credits API (GETs carry no content-type)', async () => {
    const { fetchFn, last } = recordingFetch((url) =>
      url.includes('/balance') ? { confirmedBalance: 500, asOfCheckpoint: '100' } : [{ id: 'tx-1' }],
    );
    const client = new OctaPointClient({ baseUrl: 'https://api.octap.network', fetchFn });

    expect((await client.getBalance('user-1')).confirmedBalance).toBe(500);
    expect(last().url).toBe('https://api.octap.network/v1/credits/members/user-1/balance');
    expect(last().headers).toEqual({ accept: 'application/json' });

    expect(await client.listTransactions('user-1', { limit: 10 })).toEqual([{ id: 'tx-1' }]);
    expect(last().url).toBe('https://api.octap.network/v1/credits/members/user-1/transactions?limit=10');

    await client.listTransactions('user-1');
    expect(last().url).toBe('https://api.octap.network/v1/credits/members/user-1/transactions');
  });

  it('the (programId, memberId) getBalance overload returns the snake_case BalanceSnapshot', async () => {
    const snapshot = {
      confirmedBalance: 5,
      pendingEarn: 1,
      pendingRedemption: 2,
      asOfCheckpoint: null,
      observedAt: 'now',
      stale: true,
    };
    const { fetchFn, last } = recordingFetch(() => snapshot);
    const client = new OctaPointClient({ fetchFn });

    expect(await client.getBalance('program-1', 'user-1')).toEqual({
      confirmed_balance: '5',
      pending_earn: '1',
      pending_redemption: '2',
      as_of_checkpoint: '0',
      observed_at: 'now',
      stale: true,
    });
    expect(last().url).toBe('http://localhost:3000/v1/credits/members/user-1/balance');

    const withCheckpoint = new OctaPointClient({
      fetchFn: recordingFetch(() => ({ ...snapshot, asOfCheckpoint: '42' })).fetchFn,
    });
    expect((await withCheckpoint.getBalance('program-1', 'user-1')).as_of_checkpoint).toBe('42');
  });

  it('voucher lifecycle (create, list, get, claim, redeem, listMember)', async () => {
    const { fetchFn, last } = recordingFetch((url, init) => {
      if (url.includes('/claim')) return { serialCode: 'DISCOUNT-ABC123' };
      if (url.endsWith('/redeem')) return { serialCode: JSON.parse(String(init.body)).serialCode, status: 'REDEEMED' };
      return { id: 'v-10' };
    });
    const client = createOctaPointClient({ baseUrl: 'https://api.octap.network', fetchFn });

    await client.createVoucher({ code: 'DISCOUNT', title: '10% Off', discountType: 'PERCENTAGE', pointsCost: 100 });
    expect(last()).toMatchObject({ url: 'https://api.octap.network/v1/rewards/vouchers', method: 'POST' });

    await client.listVouchers();
    expect(last()).toMatchObject({ url: 'https://api.octap.network/v1/rewards/vouchers', method: 'GET' });

    await client.getVoucher('v-10');
    expect(last().url).toBe('https://api.octap.network/v1/rewards/vouchers/v-10');

    expect((await client.claimVoucher('v-10', { organizationEndUserId: 'user-1' })).serialCode).toBe('DISCOUNT-ABC123');
    expect(last().url).toBe('https://api.octap.network/v1/rewards/vouchers/v-10/claim');

    expect((await client.redeemVoucher({ serialCode: 'DISCOUNT-ABC123' })).status).toBe('REDEEMED');
    expect(last().url).toBe('https://api.octap.network/v1/rewards/vouchers/redeem');

    await client.listMemberVouchers('user-1');
    expect(last().url).toBe('https://api.octap.network/v1/rewards/members/user-1/vouchers');
  });

  it('throws OctaApiError on error responses, reading the server message', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: jsonHeaders,
      json: async () => ({ message: 'Insufficient points balance' }),
    })) as unknown as typeof fetch;

    const err = await createOctaPointClient({ fetchFn })
      .redeemPoints({ organizationEndUserId: 'user-1', pointsAmount: 9999, idempotencyKey: 'idem' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OctaApiError);
    expect(err).toBeInstanceOf(OctaSdkError);
    expect(err).toMatchObject({
      statusCode: 400,
      statusText: 'Bad Request',
      message: 'Insufficient points balance',
      name: 'OctaApiError',
    });
  });

  it('reads a text body for non-JSON responses and tolerates malformed JSON', async () => {
    const textFetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: textHeaders,
      text: async () => 'upstream down',
    }));
    const err = (await new OctaPointClient({ fetchFn: textFetch as unknown as typeof fetch })
      .listVouchers()
      .catch((e: unknown) => e)) as OctaApiError;
    expect(err.responseBody).toBe('upstream down');
    expect(err.message).toBe('API request failed with status 502 (Bad Gateway)');

    const brokenJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON');
      },
    }));
    expect(await new OctaPointClient({ fetchFn: brokenJson as unknown as typeof fetch }).listVouchers()).toBeNull();

    const noContentType = vi.fn(async () => ({
      ok: true,
      status: 204,
      headers: { get: () => null },
      text: async () => '',
    }));
    expect(await new OctaPointClient({ fetchFn: noContentType as unknown as typeof fetch }).listVouchers()).toBe('');
  });

  it('wraps a network failure in OctaSdkError naming the request', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(new OctaPointClient({ fetchFn }).listVouchers()).rejects.toThrow(
      'Network request failed for GET http://localhost:3000/v1/rewards/vouchers: ECONNRESET',
    );

    const stringFailure = vi.fn(async () => {
      throw 'offline';
    }) as unknown as typeof fetch;
    await expect(new OctaPointClient({ fetchFn: stringFailure }).listVouchers()).rejects.toThrow(/: offline$/);
  });

  it('resolves base URL and fetch from a REST transport, and falls back to global fetch', async () => {
    const { fetchFn, last } = recordingFetch(() => []);
    await new OctaPointClient({ transport: { kind: 'rest', baseUrl: 'https://t.example', fetchFn } }).listVouchers();
    expect(last().url).toBe('https://t.example/v1/rewards/vouchers');

    const global = recordingFetch(() => []);
    vi.stubGlobal('fetch', global.fetchFn);
    await new OctaPointClient({ transport: { kind: 'rest', baseUrl: 'https://t.example' } }).listVouchers();
    expect(global.last().url).toBe('https://t.example/v1/rewards/vouchers');
  });

  it('refuses to construct without any fetch implementation', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => new OctaPointClient()).toThrow(/Global fetch is not available/);
  });

  it('waitForOperation echoes the operation reference', async () => {
    expect(await new OctaPointClient({ fetchFn: recordingFetch().fetchFn }).waitForOperation('op-1')).toEqual({
      operation_id: 'op-1',
    });
  });
});

describe('OctaApiError', () => {
  it('joins an array of validation messages, and honours an explicit message', () => {
    expect(new OctaApiError(400, 'Bad Request', { message: ['a is required', 'b is required'] }).message).toBe(
      'a is required, b is required',
    );
    expect(new OctaApiError(500, 'Oops', null, 'custom').message).toBe('custom');
  });
});

describe('customer-signed voucher claims', () => {
  it('reads claim state and finalizes with a customer signature without a merchant credential', async () => {
    const { fetchFn, last } = recordingFetch(() => ({ status: 'AVAILABLE' }));
    const client = createOctaPointClient({ fetchFn });
    expect((await client.getVoucherClaim('coupon')).status).toBe('AVAILABLE');
    expect(last().url).toContain('/v1/rewards/claims/coupon');
    await client.finalizeVoucherClaim({ digest: 'digest', signature: 'customer-signature' });
    expect(last()).toMatchObject({ method: 'POST', body: { digest: 'digest', signature: 'customer-signature' } });
    expect(last().headers.authorization).toBeUndefined();
  });

  it('accepts per-request options like every other client method', async () => {
    const { fetchFn, last } = recordingFetch(() => ({ status: 'AVAILABLE' }));
    const client = createOctaPointClient({ fetchFn });
    await client.getVoucherClaim('coupon', { organizationId: 'org-override' });
    expect(last().headers['x-organization-id']).toBe('org-override');
    await client.finalizeVoucherClaim({ digest: 'digest', signature: 'sig' }, { organizationId: 'org-override' });
    expect(last().headers['x-organization-id']).toBe('org-override');
  });
});

describe('voucher refund policy SDK', () => {
  it('reads, replaces and lists policies through tenant-scoped API methods', async () => {
    const { fetchFn, last } = recordingFetch(() => ({ version: 1 }));
    const client = createOctaPointClient({ credentials: { apiKey: 'admin' }, fetchFn });
    const signal = new AbortController().signal;
    const request = {
      allowUnused: true,
      allowExpired: true,
      allowRedeemed: false,
      restockUnused: false,
      refundWindowDays: 7,
      reason: 'New terms',
    };
    await client.getVoucherRefundPolicy({ signal, organizationId: 'org' });
    expect(last()).toMatchObject({
      method: 'GET',
      url: 'http://localhost:3000/v1/rewards/refund-policy',
      headers: { 'x-organization-id': 'org' },
    });
    await client.setVoucherRefundPolicy(request, { signal });
    expect(last()).toMatchObject({ method: 'PUT', body: request });
    await client.listVoucherRefundPolicyHistory();
    expect(last()).toMatchObject({ method: 'GET', url: 'http://localhost:3000/v1/rewards/refund-policy/history' });
    await client.listVoucherRefundPolicyHistory(
      { limit: 2, beforeVersion: 7 },
      { organizationId: 'another-org', signal },
    );
    expect(last()).toMatchObject({
      method: 'GET',
      url: 'http://localhost:3000/v1/rewards/refund-policy/history?limit=2&beforeVersion=7',
      headers: { 'x-organization-id': 'another-org' },
    });
  });
});
