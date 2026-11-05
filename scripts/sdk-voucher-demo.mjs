import { createOctaPointClient, OctaApiError } from '@octap/sdk';
import { URL } from 'node:url';

/** Read configuration without logging credentials or loading the application's .env. */
export function readDemoConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} before running the demo.`);
    return value;
  };
  const uuid = (name) => {
    const value = required(name);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${name} must be a UUID.`);
    }
    return value;
  };
  const baseUrl = env.OCTAP_API_URL?.trim() || 'http://127.0.0.1:3000';
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OCTAP_API_URL must be an HTTP(S) base URL without credentials, query or fragment.');
  }
  const runId = required('OCTAP_DEMO_RUN_ID');
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(runId)) {
    throw new Error('OCTAP_DEMO_RUN_ID must contain 1–64 letters, numbers or hyphens.');
  }
  return {
    baseUrl,
    apiKey: required('OCTAP_API_KEY'),
    memberId: uuid('OCTAP_DEMO_MEMBER_ID'),
    voucherId: uuid('OCTAP_DEMO_VOUCHER_ID'),
    idempotencyKey: `sdk-demo-${runId}`,
  };
}

/** All business requests go through the public merchant SDK. No mutations are retried. */
export async function runVoucherDemo(client, config, log = console.log) {
  const { memberId, voucherId, idempotencyKey } = config;
  log('Node SDK demo: customer-signed voucher claim and redemption.');
  const before = await client.getBalance(memberId);
  const voucher = await client.getVoucher(voucherId);
  if (before.stale || before.pendingEarn !== 0 || before.pendingRedemption !== 0) {
    throw new Error('Member balance is unsettled. Wait for pending operations before starting.');
  }
  if (!Number.isSafeInteger(voucher.pointsCost) || voucher.pointsCost <= 0) {
    throw new Error('Use a voucher with a positive, safe-integer points cost.');
  }
  const now = Date.now();
  if (
    voucher.status !== 'ACTIVE' ||
    (voucher.startsAt && new Date(voucher.startsAt).getTime() > now) ||
    (voucher.expiresAt && new Date(voucher.expiresAt).getTime() <= now) ||
    (voucher.totalSupply != null && voucher.claimedCount >= voucher.totalSupply)
  ) {
    throw new Error('Voucher must be active, within its availability dates and in stock.');
  }
  if (before.confirmedBalance < voucher.pointsCost) {
    throw new Error(`Insufficient confirmed points: need ${voucher.pointsCost}, have ${before.confirmedBalance}.`);
  }
  const existing = await client.listMemberVouchers(memberId);
  if (existing.some((owned) => owned.voucherId === voucherId)) {
    throw new Error('Member already owns this voucher. Inspect that ownership instead of claiming again.');
  }
  const history = await client.listTransactions(memberId, { limit: 50 });
  if (history.some((transaction) => transaction.idempotencyKey === idempotencyKey)) {
    throw new Error('This run ID already appears in member history. Inspect the previous attempt before continuing.');
  }
  log(`Before: ${before.confirmedBalance} confirmed points; reward cost: ${voucher.pointsCost}.`);
  log(`Claim reference: ${idempotencyKey}. Mutations will not be automatically retried.`);
  let claim = await client.claimVoucher(voucherId, { organizationEndUserId: memberId, idempotencyKey });
  // Print the recovery reference before attempting the next mutation.
  log(`Claim created: ${claim.voucherOwnershipId}; serial: ${claim.serialCode}; status: ${claim.status}.`);
  if (claim.voucherId !== voucherId || claim.organizationEndUserId !== memberId) {
    throw new Error('Unexpected claim result. Inspect ownership and balance before continuing.');
  }
  if (claim.status === 'RESERVED') {
    if (!claim.digest || !claim.transactionBytes || claim.pointsDeducted !== 0)
      throw new Error('Invalid pending claim');
    if (!config.signTransaction) {
      log(`Customer signature required for digest ${claim.digest}. Transaction bytes: ${claim.transactionBytes}`);
      log(
        'Sign these bytes in the customer zkLogin session, call finalizeVoucherClaim, then read getVoucherClaim. A RESERVED voucher cannot be used.',
      );
      return { before, claim, pending: true };
    }
    const signature = await config.signTransaction(claim.transactionBytes, claim.digest);
    await client.finalizeVoucherClaim({ digest: claim.digest, signature });
    claim = await client.getVoucherClaim(claim.voucherOwnershipId);
  }
  if (
    claim.status !== 'AVAILABLE' ||
    claim.pointsDeducted !== voucher.pointsCost ||
    claim.voucherId !== voucherId ||
    claim.organizationEndUserId !== memberId
  ) {
    throw new Error('Unexpected claim result. Inspect ownership and balance before continuing.');
  }
  // Only the customer's signature can mark a voucher used: the API key can only ask.
  const use = await client.prepareVoucherUse({ serialCode: claim.serialCode, idempotencyKey: `${idempotencyKey}-use` });
  if (!use.digest || !use.transactionBytes) throw new Error('Invalid voucher use');
  const useSignature = await config.signTransaction(use.transactionBytes, use.digest);
  const redeemed = await client.finalizeVoucherUse({ digest: use.digest, signature: useSignature });
  log(`Redemption response: ${redeemed.status}. Reading persisted state…`);
  const after = await client.getBalance(memberId);
  const owned = await client.listMemberVouchers(memberId);
  const transactions = await client.listTransactions(memberId, { limit: 50 });
  const ownership = owned.find((item) => item.id === claim.voucherOwnershipId);
  const transaction = transactions.find((item) => item.idempotencyKey === idempotencyKey);
  if (
    redeemed.voucherOwnershipId !== claim.voucherOwnershipId ||
    redeemed.status !== 'REDEEMED' ||
    ownership?.status !== 'REDEEMED' ||
    after.confirmedBalance !== before.confirmedBalance - voucher.pointsCost ||
    after.stale ||
    !transaction ||
    transaction.transactionType !== 'REDEEM' ||
    transaction.status !== 'CONFIRMED' ||
    transaction.pointsAmount !== voucher.pointsCost
  ) {
    throw new Error('Persisted result differs from the expected demo outcome. Inspect records; do not re-claim.');
  }
  log(`Verified: ${before.confirmedBalance} → ${after.confirmedBalance} points; voucher REDEEMED.`);
  log(
    `Points transaction: ${transaction.id}. The paid claim was confirmed through the customer-signed redemption pipeline.`,
  );
  return { before, after, claim, redeemed, ownership, transaction };
}

if (import.meta.main) {
  try {
    const config = readDemoConfig();
    const client = createOctaPointClient({
      baseUrl: config.baseUrl,
      credentials: { apiKey: config.apiKey },
      fetchFn: (url, init) => globalThis.fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(15_000) }),
    });
    await runVoucherDemo(client, config);
  } catch (error) {
    // API bodies can echo request data; don't print credentials or raw response bodies.
    console.error(
      error instanceof OctaApiError
        ? `Core rejected a request (HTTP ${error.statusCode}).`
        : error instanceof Error
          ? error.message
          : 'Unknown demo error.',
    );
    console.error('Stopped. Inspect balance, owned vouchers and history before retrying any mutation.');
    process.exitCode = 1;
  }
}
