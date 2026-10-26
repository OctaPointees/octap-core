import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createOctaPointClient, OctaApiError } from '@octap/sdk';
import { readDemoConfig, runVoucherDemo } from '../sdk-voucher-demo.mjs';
import { closeDemoResources } from '../lib/close-demo-resources.mjs';

const memberId = '11111111-1111-4111-8111-111111111111';
const voucherId = '22222222-2222-4222-8222-222222222222';
const config = { memberId, voucherId, idempotencyKey: 'sdk-demo-test-001' };

test('cleanup attempts database and containers even after an earlier closer fails', async () => {
  const calls = [];
  await assert.rejects(
    closeDemoResources([
      async () => {
        calls.push('api');
        throw new Error('close failed');
      },
      async () => {
        calls.push('database');
      },
      async () => {
        calls.push('redis');
        throw new Error('stop failed');
      },
      async () => {
        calls.push('postgres');
      },
    ]),
    { name: 'AggregateError' },
  );
  assert.deepEqual(calls, ['api', 'database', 'redis', 'postgres']);
  await closeDemoResources([async () => {}]);
});

async function fixture(t, overrides = {}) {
  const calls = [];
  const state = { balance: 100, claimed: false, redeemed: false, ...overrides };
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    const send = (data, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    const ownership = {
      id: 'ownership-1',
      voucherId,
      serialCode: 'COFFEE-ABC',
      status: state.redeemed ? 'REDEEMED' : 'AVAILABLE',
    };
    if (req.url.endsWith('/balance')) {
      return send({
        confirmedBalance: state.balance,
        pendingEarn: state.pending ? 10 : 0,
        pendingRedemption: 0,
        stale: !!state.pending,
      });
    }
    if (req.url === `/v1/rewards/vouchers/${voucherId}`) {
      return send({
        id: voucherId,
        pointsCost: 25,
        status: state.voucherStatus ?? 'ACTIVE',
        totalSupply: 100,
        claimedCount: 0,
      });
    }
    if (req.url.endsWith('/vouchers') && req.method === 'GET') {
      return send(state.claimed ? [ownership] : []);
    }
    if (req.url.includes('/transactions')) {
      return send(
        state.claimed
          ? [
              {
                id: 'transaction-1',
                idempotencyKey: config.idempotencyKey,
                transactionType: 'REDEEM',
                status: 'CONFIRMED',
                pointsAmount: 25,
              },
            ]
          : [],
      );
    }
    if (req.url.endsWith('/claim')) {
      if (state.claimFails) return send({ message: 'Claim failed' }, 503);
      state.claimed = true;
      state.balance -= 25;
      return send({
        ...ownership,
        voucherOwnershipId: ownership.id,
        pointsDeducted: 25,
        organizationEndUserId: state.claimMemberId ?? memberId,
      });
    }
    if (req.url.endsWith('/redeem')) {
      if (state.redeemFails) return send({ message: 'Redemption failed' }, 503);
      state.redeemed = true;
      return send({ voucherOwnershipId: ownership.id, status: 'REDEEMED' });
    }
    send({ message: 'Unknown route' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const client = createOctaPointClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    credentials: { apiKey: 'fixture-key' },
  });
  return { client, calls, state };
}

test('public SDK spends points once, redeems the claimed serial and reads persisted state', async (t) => {
  const { client, calls } = await fixture(t);
  const logs = [];
  const result = await runVoucherDemo(client, config, (line) => logs.push(line));
  assert.equal(result.after.confirmedBalance, 75);
  assert.equal(result.ownership.status, 'REDEEMED');
  const writes = calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, { organizationEndUserId: memberId, idempotencyKey: config.idempotencyKey });
  assert.deepEqual(writes[1].body, { serialCode: 'COFFEE-ABC' });
  assert.ok(calls.every((call) => call.authorization === 'Bearer fixture-key'));
  assert.ok(logs.some((line) => line.includes('100 → 75')));
  assert.ok(logs.every((line) => !line.includes('fixture-key')));
  // A repeat run must stop before a second mutation, even with a different run ID.
  await assert.rejects(
    runVoucherDemo(client, { ...config, idempotencyKey: 'another-run' }, () => {}),
    /already owns/,
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

for (const [name, state, message] of [
  ['insufficient points', { balance: 10 }, /Insufficient/],
  ['unsettled balance', { pending: true }, /unsettled/],
  ['inactive reward', { voucherStatus: 'PAUSED' }, /active/],
]) {
  test(`preflight rejects ${name} without mutations`, async (t) => {
    const { client, calls } = await fixture(t, state);
    await assert.rejects(
      runVoucherDemo(client, config, () => {}),
      message,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });
}

test('failed claim is not retried and cannot trigger redemption', async (t) => {
  const { client, calls } = await fixture(t, { claimFails: true });
  await assert.rejects(
    runVoucherDemo(client, config, () => {}),
    OctaApiError,
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(!calls.some((call) => call.url.endsWith('/redeem')));
});

test('does not redeem a claim response belonging to a different member', async (t) => {
  const { client, calls } = await fixture(t, { claimMemberId: 'different-member' });
  await assert.rejects(
    runVoucherDemo(client, config, () => {}),
    /Unexpected claim result/,
  );
  assert.ok(!calls.some((call) => call.url.endsWith('/redeem')));
});

test('failed redemption preserves a printed claim recovery reference without retrying', async (t) => {
  const { client, calls } = await fixture(t, { redeemFails: true });
  const logs = [];
  await assert.rejects(
    runVoucherDemo(client, config, (line) => logs.push(line)),
    OctaApiError,
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.ok(logs.some((line) => line.includes('ownership-1') && line.includes('COFFEE-ABC')));
});

test('verification fails when persisted state disagrees with redemption response', async (t) => {
  const { client } = await fixture(t);
  const list = client.listMemberVouchers.bind(client);
  let reads = 0;
  client.listMemberVouchers = async (...args) => (++reads === 2 ? [] : list(...args));
  await assert.rejects(
    runVoucherDemo(client, config, () => {}),
    /Persisted result differs/,
  );
});

test('configuration requires explicit prepared fixture IDs and a stable run reference', () => {
  assert.throws(() => readDemoConfig({}), /OCTAP_DEMO_RUN_ID/);
  const env = {
    OCTAP_API_KEY: 'private',
    OCTAP_DEMO_MEMBER_ID: memberId,
    OCTAP_DEMO_VOUCHER_ID: voucherId,
    OCTAP_DEMO_RUN_ID: 'test-001',
  };
  assert.equal(readDemoConfig(env).idempotencyKey, config.idempotencyKey);
  assert.throws(() => readDemoConfig({ ...env, OCTAP_DEMO_MEMBER_ID: 'not-a-uuid' }), /UUID/);
  assert.throws(
    () => readDemoConfig({ ...env, OCTAP_API_URL: 'https://user:pass@example.com' }),
    /without credentials/,
  );
});
