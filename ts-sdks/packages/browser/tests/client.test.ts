import { describe, expect, it, vi } from 'vitest';
import { OctaBrowserClient, createBrowserClient } from '../src/index.js';

/** Stubs global fetch (the browser SDK takes no fetchFn) and records every call. */
function stubFetch(
  respond: (url: string) => {
    ok?: boolean;
    status?: number;
    statusText?: string;
    body?: unknown;
    text?: string;
  } = () => ({}),
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = respond(url);
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        statusText: r.statusText ?? 'OK',
        json: async () => {
          if (r.text !== undefined) throw new SyntaxError('not json');
          return r.body ?? {};
        },
        text: async () => r.text ?? '',
      };
    }),
  );
  return { calls, last: () => calls[calls.length - 1] };
}

describe('OctaBrowserClient', () => {
  it('uses authenticated console/platform contracts for onboarding and invitations', async () => {
    const { last } = stubFetch();
    const client = createBrowserClient({ apiBaseUrl: 'https://core', getAuthToken: () => 'google' });
    await client.requestConsoleOrganization({
      name: 'Business',
      slug: 'business',
      organizationType: 'INDIVIDUAL_HOUSEHOLD',
      representativeName: 'Owner',
    });
    expect(last()).toMatchObject({
      url: 'https://core/v1/console/organization-requests',
      method: 'POST',
      body: {
        name: 'Business',
        slug: 'business',
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Owner',
      },
      headers: { authorization: 'Bearer google' },
    });
    await client.listConsoleOrganizationRequests();
    expect(last().url).toBe('https://core/v1/console/organization-requests');
    await client.listPlatformOrganizationRequests();
    expect(last().url).toBe('https://core/v1/platform/organization-requests');
    await client.decidePlatformOrganizationRequest('request/id', 'reject', 'Reason');
    expect(last()).toMatchObject({
      url: 'https://core/v1/platform/organization-requests/request%2Fid/reject',
      method: 'POST',
      body: { reason: 'Reason' },
    });
    await client.getConsoleOrganization('org');
    expect(last().url).toBe('https://core/v1/console/organizations/org');
    await client.updateConsoleOrganizationProfile('org', { name: 'Renamed' });
    expect(last()).toMatchObject({
      url: 'https://core/v1/console/organizations/org/profile',
      method: 'PATCH',
      body: { name: 'Renamed' },
    });
    await client.listConsoleStaff('org');
    expect(last().url).toBe('https://core/v1/console/organizations/org/staff');
    await client.listConsoleCredentials('org');
    expect(last().url).toBe('https://core/v1/console/organizations/org/api-credentials');
    await client.createConsoleInvitation('org', 'developer@example.com');
    expect(last().body).toEqual({ email: 'developer@example.com', persona: 'BUSINESS_DEVELOPER' });
    await client.listConsoleInvitations('org');
    expect(last().url).toBe('https://core/v1/console/organizations/org/invitations');
    await client.revokeConsoleInvitation('org', 'invite');
    expect(last().url).toBe('https://core/v1/console/organizations/org/invitations/invite/revoke');
    await client.acceptConsoleInvitation('token/path');
    expect(last().url).toBe('https://core/v1/console/invitations/token%2Fpath/accept');
  });
  it('forwards cancellation and disables caching for console credentials', async () => {
    stubFetch();
    const signal = new AbortController().signal;
    const client = createBrowserClient({ apiBaseUrl: '', getAuthToken: () => 'credential' });
    await client.loginConsoleWithGoogle('credential', { signal });
    expect(fetch).toHaveBeenLastCalledWith(
      '/v1/console/auth/google',
      expect.objectContaining({ signal, cache: 'no-store' }),
    );
    await client.getConsoleIdentity({ signal });
    expect(fetch).toHaveBeenLastCalledWith(
      '/v1/console/me',
      expect.objectContaining({
        signal,
        cache: 'no-store',
        headers: expect.objectContaining({ authorization: 'Bearer credential' }),
      }),
    );
  });
  it('authenticates portal users through dedicated Google console endpoints', async () => {
    const { last } = stubFetch();
    const client = createBrowserClient({ apiBaseUrl: 'https://a', getAuthToken: () => 'google-id-token' });
    await client.loginConsoleWithGoogle('google-id-token');
    expect(last()).toMatchObject({
      url: 'https://a/v1/console/auth/google',
      method: 'POST',
      body: { idToken: 'google-id-token' },
    });
    await client.getConsoleIdentity();
    expect(last()).toMatchObject({
      url: 'https://a/v1/console/me',
      method: 'GET',
      headers: { authorization: 'Bearer google-id-token' },
    });
  });
  it('reads balance with the end user’s bearer token and default org', async () => {
    const { last } = stubFetch(() => ({ body: { confirmedBalance: 250 } }));
    const client = new OctaBrowserClient({
      apiBaseUrl: 'https://api.octap.network/',
      organizationId: 'org-browser',
      getAuthToken: () => 'user-jwt-token-123',
    });

    expect((await client.getBalance('user-1')).confirmedBalance).toBe(250);
    expect(last()).toEqual({
      url: 'https://api.octap.network/v1/credits/members/user-1/balance',
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-organization-id': 'org-browser',
        authorization: 'Bearer user-jwt-token-123',
      },
      body: undefined,
    });
  });

  it('awaits an async token getter, and sends no auth header for a null token', async () => {
    const { last } = stubFetch();
    await new OctaBrowserClient({ apiBaseUrl: 'https://a', getAuthToken: async () => 'async-token' }).listVouchers();
    expect(last().headers.authorization).toBe('Bearer async-token');

    await new OctaBrowserClient({ apiBaseUrl: 'https://a', getAuthToken: () => null }).listVouchers();
    expect(last().headers).toEqual({ accept: 'application/json' });
  });

  it('covers the credits, rewards, and identity routes', async () => {
    const { last } = stubFetch();
    const client = createBrowserClient({ apiBaseUrl: 'https://a', organizationId: 'org-1' });

    await client.listTransactions('user-1');
    expect(last().url).toBe('https://a/v1/credits/members/user-1/transactions?limit=50');
    await client.listTransactions('user-1', 5);
    expect(last().url).toBe('https://a/v1/credits/members/user-1/transactions?limit=5');

    await client.listVouchers('org-override');
    expect(last().headers['x-organization-id']).toBe('org-override');
    await client.getVoucher('v-1');
    expect(last().url).toBe('https://a/v1/rewards/vouchers/v-1');
    await client.listMemberVouchers('user-1');
    expect(last().url).toBe('https://a/v1/rewards/members/user-1/vouchers');

    await client.claimVoucher('v-1', 'user-1', 'claim-key', 'org-2');
    expect(last()).toMatchObject({
      url: 'https://a/v1/rewards/vouchers/v-1/claim',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-organization-id': 'org-2' },
      body: { organizationEndUserId: 'user-1', idempotencyKey: 'claim-key' },
    });
    await client.claimVoucher('v-1', 'user-1');
    expect((last().body as { idempotencyKey: string }).idempotencyKey).toMatch(/^claim-\d+-[a-z0-9]+$/);

    await client.loginWithGoogle('google-jwt');
    expect(last()).toMatchObject({ url: 'https://a/v1/identity/google-login', body: { idToken: 'google-jwt' } });

    await client.enroll('eu-1');
    expect(last()).toMatchObject({
      url: 'https://a/v1/identity/organizations/org-1/enroll',
      body: { endUserId: 'eu-1' },
    });
    await client.enroll('eu-1', 'org-9', 'ext-1');
    expect(last()).toMatchObject({
      url: 'https://a/v1/identity/organizations/org-9/enroll',
      body: { endUserId: 'eu-1', externalMemberId: 'ext-1' },
    });
  });

  it('enroll needs an organization from somewhere', async () => {
    await expect(new OctaBrowserClient({ apiBaseUrl: 'https://a' }).enroll('eu-1')).rejects.toThrow(
      /organizationId is required/,
    );
  });

  it('surfaces the server’s message, or a status line for a non-JSON error body', async () => {
    stubFetch(() => ({ ok: false, status: 404, statusText: 'Not Found', body: { message: 'Voucher not found' } }));
    await expect(new OctaBrowserClient({ apiBaseUrl: 'https://a' }).getVoucher('v-x')).rejects.toThrow(
      'Voucher not found',
    );

    stubFetch(() => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: '<html>' }));
    await expect(new OctaBrowserClient({ apiBaseUrl: 'https://a' }).getVoucher('v-x')).rejects.toThrow(
      'Octa Browser SDK request failed: 502 Bad Gateway',
    );
  });
});

describe('customer-signed voucher claims', () => {
  it('finalizes from the customer device without a merchant key and reads persisted state', async () => {
    const { last } = stubFetch(() => ({ body: { status: 'AVAILABLE' } }));
    const client = createBrowserClient({ apiBaseUrl: 'https://api.example.com' });
    await client.finalizeVoucherClaim({ digest: 'digest', signature: 'customer-signature' });
    expect(last()).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/v1/credits/redeem/finalize',
      body: { digest: 'digest', signature: 'customer-signature' },
    });
    expect(last().headers.authorization).toBeUndefined();
    expect((await client.getVoucherClaim('coupon')).status).toBe('AVAILABLE');
    expect(last().url).toBe('https://api.example.com/v1/rewards/claims/coupon');
  });
});
