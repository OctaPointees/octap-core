/* global fetch */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
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
  getVoucherClaim: async (ownershipId) => ({ voucherOwnershipId: ownershipId, status: 'AVAILABLE' }),
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
  assert.deepEqual(Object.keys(publicConfig).sort(), ['apiBaseUrl', 'googleClientId', 'organizationId']);
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

test('reads the claim state for a verified member, and answers 404 elsewhere', async () => {
  const state = await post('/api/claim/state', 'active-token', { ownershipId: 'ownership-1' });
  assert.deepEqual(await state.json(), { voucherOwnershipId: 'ownership-1', status: 'AVAILABLE' });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
