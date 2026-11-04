import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { checkBalanceChange } from '../../ts-sdks/examples/browser-auth/checks.mjs';
/* global fetch, Response, URL */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { OctaApiError } from '@octap/sdk';
import { bundlePage, createHandler, readConfig } from '../../ts-sdks/examples/browser-auth/server.mjs';

const API_KEY = 'octap-merchant-secret-key';
const config = readConfig({
  OCTAP_API_KEY: API_KEY,
  OCTAP_ORGANIZATION_ID: 'org-1',
  GOOGLE_CLIENT_ID: 'google-client',
  OCTAP_VOUCHER_ID: 'voucher-1',
});

const claims = [];
const merchant = {
  getVoucher: async () => ({ title: 'Test coffee', pointsCost: 25 }),
  listMemberVouchers: async () => [],
  verifyCustomer: async (idToken) =>
    ({
      'active-token': { memberId: 'member-1', active: true },
      'blocked-token': { memberId: 'member-2', active: false },
      'unenrolled-token': { memberId: null, active: false },
    })[idToken] ??
    (() => {
      throw Object.assign(new Error('The sign-in token is invalid'), { status: 401 });
    })(),
  claimVoucher: async (voucherId, request) => {
    claims.push({ voucherId, ...request });
    return { voucherOwnershipId: 'ownership-1', status: 'RESERVED' };
  },
  getVoucherClaim: async (ownershipId) => ({
    voucherOwnershipId: ownershipId,
    organizationEndUserId: ownershipId === 'ownership-1' ? 'member-1' : 'member-9',
    serialCode: 'SERIAL',
    status: 'AVAILABLE',
  }),
};

let script;
let server;
let base;

before(async () => {
  script = await bundlePage();
  server = createServer(createHandler(config, merchant, { html: '<!doctype html>', script }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

const post = (path, token, body = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });

test('readConfig names the variable that is missing', () => {
  assert.throws(() => readConfig({}), /OCTAP_API_KEY/);
});

test('the page gets public configuration only, and no credential reaches its bundle', async () => {
  const publicConfig = await (await fetch(`${base}/config`)).json();
  assert.deepEqual(Object.keys(publicConfig).sort(), ['apiBaseUrl', 'googleClientId', 'organizationId', 'voucher']);
  const served = await (await fetch(`${base}/app.js`)).text();
  assert.ok(served.includes('/v1/identity/zklogin/nonce'), 'the bundle should contain the SDK');
  for (const forbidden of [API_KEY, 'ENOKI_API_KEY', 'api.enoki.mystenlabs.com', 'OCTAP_API_KEY']) {
    assert.ok(!served.includes(forbidden), `the bundle must not contain ${forbidden}`);
  }
});

test('a claim needs a verified, active member, whatever the page sends', async () => {
  assert.equal((await post('/api/claim', 'invalid-token')).status, 401);
  assert.equal((await post('/api/claim', 'blocked-token')).status, 403);
  assert.equal((await post('/api/claim', 'unenrolled-token')).status, 403);
  assert.equal((await post('/api/claim')).status, 401);
  assert.equal(claims.length, 0);

  const response = await post('/api/claim', 'active-token', { organizationEndUserId: 'someone-else' });

  assert.equal(response.status, 200);
  assert.deepEqual(claims, [
    {
      voucherId: 'voucher-1',
      organizationEndUserId: 'member-1',
      idempotencyKey: 'browser-auth-member-1-voucher-1',
    },
  ]);
});

test("reads only the verified member's own claim, and answers 404 elsewhere", async () => {
  const state = await post('/api/claim/state', 'active-token', { ownershipId: 'ownership-1' });
  assert.equal((await state.json()).status, 'AVAILABLE');

  const other = await post('/api/claim/state', 'active-token', { ownershipId: 'ownership-of-another-customer' });
  assert.equal(other.status, 404);
  assert.ok(!(await other.text()).includes('SERIAL'));

  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('backend flow uses verified balance, returns signing bytes, finalizes the original handoff digest and redeems only an owned claim', async () => {
  const calls = [];
  let claim = {
    voucherOwnershipId: 'owned',
    organizationEndUserId: 'member-1',
    status: 'RESERVED',
    digest: 'persisted-digest',
    transactionBytes: 'base64-bytes',
    serialCode: 'OWNED-SERIAL',
  };
  const sdk = {
    listMemberVouchers: async () => [],
    verifyCustomer: merchant.verifyCustomer,
    getBalance: async (memberId) => {
      calls.push(['balance', memberId]);
      return { confirmedBalance: 100 };
    },
    claimVoucher: async () => claim,
    getVoucherClaim: async (id) => ({
      ...claim,
      organizationEndUserId: id === 'other' ? 'member-9' : 'member-1',
      digest: null,
      transactionBytes: null,
    }),
    finalizeVoucherClaim: async (request) => {
      calls.push(['finalize', request]);
      claim = { ...claim, status: 'AVAILABLE', digest: null, transactionBytes: null };
    },
    redeemVoucher: async (request) => {
      calls.push(['redeem', request]);
      return { status: 'REDEEMED' };
    },
  };
  const local = createServer(createHandler(config, sdk, { html: '', script: '' }));
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const send = (path, body = {}) =>
    fetch(`http://127.0.0.1:${local.address().port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer active-token' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await (await send('/api/balance', { memberId: 'attacker' })).json()).confirmedBalance, 100);
    assert.deepEqual(calls[0], ['balance', 'member-1']);
    const pending = await (await send('/api/claim')).json();
    assert.equal(pending.transactionBytes, 'base64-bytes');
    assert.ok(!JSON.stringify(pending).includes(API_KEY));
    assert.equal((await send('/api/claim/redeem', { ownershipId: 'owned' })).status, 409);
    assert.equal((await send('/api/claim/finalize', { ownershipId: 'other', signature: 'sig' })).status, 404);
    assert.equal((await send('/api/claim/redeem', { ownershipId: 'other' })).status, 404);
    assert.equal(calls.length, 1);
    assert.equal(
      (
        await send('/api/claim/finalize', {
          ownershipId: 'owned',
          digest: 'attacker-digest',
          signature: 'customer-signature',
        })
      ).status,
      200,
    );
    assert.deepEqual(calls[1], ['finalize', { digest: 'persisted-digest', signature: 'customer-signature' }]);
    assert.equal(
      (await send('/api/claim/finalize', { ownershipId: 'owned', signature: 'customer-signature' })).status,
      200,
    );
    assert.equal(calls.length, 2, 'settled finalize is read back without executing twice');
    assert.equal(
      (await send('/api/claim/redeem', { ownershipId: 'owned', serialCode: 'attacker-serial' })).status,
      200,
    );
    assert.deepEqual(calls[2], ['redeem', { serialCode: 'OWNED-SERIAL' }]);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test('example exposes known business failures but redacts unexpected Core bodies', async () => {
  for (const [status, upstream, expected] of [
    [400, 'Voucher has already been claimed by this member', 'Voucher has already been claimed by this member'],
    [400, 'Insufficient points', 'Insufficient points'],
    [401, 'private upstream detail', 'Core rejected authentication. Sign in again.'],
    [503, API_KEY, 'Core request failed. Inspect persisted state before retrying.'],
  ]) {
    const local = createServer(
      createHandler(
        config,
        {
          verifyCustomer: async () => {
            throw new OctaApiError(status, 'Rejected', { message: upstream });
          },
        },
        { html: '', script: '' },
      ),
    );
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${local.address().port}/api/claim`, { method: 'POST' });
      assert.equal(response.status, status);
      const body = await response.text();
      assert.equal(JSON.parse(body).message, expected);
      assert.ok(!body.includes(API_KEY));
    } finally {
      await new Promise((resolve) => local.close(resolve));
    }
  }
});

test('claim resumes an existing owned voucher without creating a second claim or debit', async () => {
  let creates = 0;
  const sdk = {
    verifyCustomer: merchant.verifyCustomer,
    listMemberVouchers: async (memberId) => {
      assert.equal(memberId, 'member-1');
      return [{ id: 'existing', voucherId: config.voucherId, status: 'AVAILABLE' }];
    },
    getVoucherClaim: async (id) => ({
      voucherOwnershipId: id,
      organizationEndUserId: 'member-1',
      status: 'AVAILABLE',
      pointsDeducted: 25,
    }),
    claimVoucher: async () => {
      creates++;
      assert.fail('must not create another claim');
    },
  };
  const local = createServer(createHandler(config, sdk, { html: '', script: '' }));
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer active-token' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      voucherOwnershipId: 'existing',
      organizationEndUserId: 'member-1',
      status: 'AVAILABLE',
      pointsDeducted: 25,
    });
    assert.equal(creates, 0);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

/** Exercise the actual page event handlers with a minimal DOM and deterministic SDK/API doubles. */
async function testPage({ recovered = false, claimedBalance = 350, redeemedBalance = claimedBalance } = {}) {
  const html = await readFile(new URL('../../ts-sdks/examples/browser-auth/index.html', import.meta.url), 'utf8');
  const elements = new Map(
    [...html.matchAll(/id="([^" ]+)"/g)].map(([, id]) => [
      id,
      {
        textContent: '',
        dataset: {},
        disabled: false,
        listeners: {},
        children: new Map(),
        addEventListener(event, listener) {
          this.listeners[event] = listener;
        },
        querySelector(selector) {
          if (!this.children.has(selector)) this.children.set(selector, { textContent: '' });
          return this.children.get(selector);
        },
      },
    ]),
  );
  const element = (id) => {
    assert.ok(elements.has(id), `Missing HTML element ${id}`);
    return elements.get(id);
  };
  let state = recovered ? 'AVAILABLE' : null;
  let signatures = 0;
  let claimsMade = 0;
  const claim = () => ({
    voucherOwnershipId: 'owned',
    status: state,
    pointsCost: 25,
    pointsDeducted: state === 'RESERVED' ? 0 : 25,
    digest: state === 'RESERVED' ? 'digest' : null,
    transactionBytes: state === 'RESERVED' ? 'bytes' : null,
  });
  const balance = () => ({
    confirmedBalance: !state || state === 'RESERVED' ? 375 : state === 'REDEEMED' ? redeemedBalance : claimedBalance,
    pendingEarn: 0,
    pendingRedemption: 0,
    stale: false,
  });
  const sdk = {
    currentUser: {},
    onAuthStateChanged(listener) {
      listener(this.currentUser);
    },
    getIdToken: async () => 'test-token',
    renderGoogleButton: async () => {},
    signTransaction: async (bytes) => {
      assert.equal(bytes, 'bytes');
      signatures++;
      return 'signature';
    },
    signOut: async () => {},
  };
  const fakeFetch = async (path) => {
    if (path === '/config') return Response.json({ voucher: { title: 'Fresh coffee', pointsCost: 25 } });
    if (path === '/api/balance') return Response.json(balance());
    if (path === '/api/claim') {
      claimsMade++;
      state ??= 'RESERVED';
      return Response.json(claim());
    }
    if (path === '/api/claim/finalize') {
      state = 'AVAILABLE';
      return Response.json(claim());
    }
    if (path === '/api/claim/state') return Response.json(claim());
    if (path === '/api/claim/redeem') {
      state = 'REDEEMED';
      return Response.json(claim());
    }
    assert.fail(`Unexpected request ${path}`);
  };
  const source = (await readFile(new URL('../../ts-sdks/examples/browser-auth/app.js', import.meta.url), 'utf8'))
    .replace("import { createOctapAuth } from '@octap/browser-sdk';", 'const createOctapAuth = globalThis.createAuth;')
    .replace(
      "import { checkBalanceChange } from './checks.mjs';",
      'const checkBalanceChange = globalThis.compareBalance;',
    );
  await runInNewContext(`(async () => { ${source} })()`, {
    document: { getElementById: element },
    fetch: fakeFetch,
    createAuth: () => sdk,
    compareBalance: checkBalanceChange,
  });
  return {
    element,
    click: async (id) => {
      assert.equal(element(id).disabled, false, `${id} should be enabled`);
      await element(id).listeners.click();
    },
    signatures: () => signatures,
    claimsMade: () => claimsMade,
  };
}

test('the visible checklist confirms a fresh signed claim and preserves claim evidence after redemption', async () => {
  const page = await testPage();
  assert.equal(page.claimsMade(), 0, 'sign-in must not automatically claim');
  await page.click('claim');
  assert.equal(page.signatures(), 1);
  for (const id of ['reserved', 'signed', 'finalized', 'claim-balance'])
    assert.equal(page.element(`check-${id}`).dataset.state, 'passed');
  assert.equal(page.element('balance-before').textContent, '375');
  assert.equal(page.element('balance-claimed').textContent, '350');
  const claimEvidence = page.element('check-claim-balance').querySelector('p').textContent;
  await page.click('redeem');
  assert.equal(page.element('check-redeemed').dataset.state, 'passed');
  assert.equal(page.element('check-redeem-balance').dataset.state, 'passed');
  assert.equal(page.element('balance-redeemed').textContent, '350');
  assert.equal(page.element('check-claim-balance').querySelector('p').textContent, claimEvidence);
  assert.equal(page.element('redeem').disabled, true);
});

test('recovered vouchers do not falsely pass fresh reservation, signing or claim-cost checks', async () => {
  const page = await testPage({ recovered: true });
  await page.click('claim');
  assert.equal(page.signatures(), 0);
  for (const id of ['reserved', 'signed', 'claim-balance'])
    assert.equal(page.element(`check-${id}`).dataset.state, 'skipped');
  assert.equal(page.element('redeem').disabled, false);
});

test('unexpected point deductions produce a visible failed check, not an overall passed result', async () => {
  const page = await testPage({ claimedBalance: 360, redeemedBalance: 350 });
  await page.click('claim');
  assert.equal(page.element('check-claim-balance').dataset.state, 'failed');
  assert.notEqual(page.element('notice').dataset.state, 'passed');
  await page.click('redeem');
  assert.equal(page.element('check-redeem-balance').dataset.state, 'failed');
  assert.notEqual(page.element('notice').dataset.state, 'passed');
});

test('pending or missing balance evidence cannot pass the point check', () => {
  const settled = { confirmedBalance: 375, pendingEarn: 0, pendingRedemption: 0, stale: false };
  assert.equal(
    checkBalanceChange(settled, { ...settled, confirmedBalance: 350, pendingRedemption: 25, stale: true }, 25).status,
    'waiting',
  );
  assert.equal(checkBalanceChange(settled, { ...settled, confirmedBalance: 350 }, 25).status, 'passed');
  assert.equal(checkBalanceChange(undefined, settled, 25).status, 'failed');
});
