// A local test harness for @octap/browser-sdk. Plays a merchant's frontend host and backend; never
// deploy it. The API key stays in this process and only reaches Core.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OctaApiError, createOctaPointClient } from '@octap/sdk';
import { build } from 'esbuild';

const here = new URL('.', import.meta.url);

/** Reads configuration from the shell, so a local .env is never loaded by accident. */
export function readConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} before running this example.`);
    return value;
  };
  return {
    port: Number(env.PORT ?? 4001),
    apiBaseUrl: env.OCTAP_API_URL?.trim() || 'http://127.0.0.1:3000',
    apiKey: required('OCTAP_API_KEY'),
    organizationId: required('OCTAP_ORGANIZATION_ID'),
    googleClientId: required('GOOGLE_CLIENT_ID'),
    voucherId: required('OCTAP_VOUCHER_ID'),
    runId: env.OCTAP_EXAMPLE_RUN_ID?.trim() || 'browser-auth',
  };
}

export async function bundlePage() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('app.js', here))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16384) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

export function createHandler(config, merchant, page) {
  // The read-only claim route deliberately omits signing bytes/digest. Retain the handoff
  // returned by the public claim method for this local session, bound to its verified owner.
  const handoffs = new Map();
  function handoffFor(ownershipId, memberId) {
    const handoff = handoffs.get(ownershipId);
    if (handoff && handoff.expiresAt <= Date.now()) handoffs.delete(ownershipId);
    return handoff && handoff.expiresAt > Date.now() && handoff.memberId === memberId ? handoff.claim : undefined;
  }
  /** The check every merchant route starts with: never trust a member ID the page sends. */
  async function verifiedMember(request) {
    const idToken = request.headers.authorization?.replace(/^Bearer /, '');
    const customer = await merchant.verifyCustomer(idToken ?? '');
    if (!customer.memberId || !customer.active) throw Object.assign(new Error('Not an active member'), { status: 403 });
    return customer.memberId;
  }

  async function ownClaim(request, ownershipId) {
    const memberId = await verifiedMember(request);
    if (typeof ownershipId !== 'string' || !ownershipId)
      throw Object.assign(new Error('ownershipId required'), { status: 400 });
    const claim = await merchant.getVoucherClaim(ownershipId);
    if (claim.organizationEndUserId !== memberId) throw Object.assign(new Error('Not found'), { status: 404 });
    return claim;
  }

  const routes = {
    'GET /': async () => ({ type: 'text/html', body: page.html }),
    'GET /app.js': async () => ({ type: 'text/javascript', body: page.script }),
    'GET /config': async () => {
      const voucher = await merchant.getVoucher(config.voucherId);
      return {
        json: {
          apiBaseUrl: config.apiBaseUrl,
          organizationId: config.organizationId,
          googleClientId: config.googleClientId,
          voucher: { title: voucher.title, pointsCost: voucher.pointsCost },
        },
      };
    },
    'POST /api/balance': async (request) => ({ json: await merchant.getBalance(await verifiedMember(request)) }),
    'POST /api/claim': async (request) => {
      const memberId = await verifiedMember(request);
      // The member may already own this reward from another integration/run key. Recover it
      // through public reads; never mint another claim or debit points to fix a UI retry.
      const owned = await merchant.listMemberVouchers(memberId);
      const existing = owned.find((item) => item.voucherId === config.voucherId && item.status !== 'CANCELLED');
      if (existing) {
        const claim = await merchant.getVoucherClaim(existing.id);
        if (claim.organizationEndUserId !== memberId) throw Object.assign(new Error('Not found'), { status: 404 });
        if (claim.status === 'RESERVED') {
          const handoff = handoffFor(claim.voucherOwnershipId, memberId);
          if (handoff) return { json: handoff };
          throw Object.assign(
            new Error(
              'An existing claim is still reserved. Resume its original request or wait for reconciliation; do not create another claim.',
            ),
            { status: 409 },
          );
        }
        return { json: claim };
      }
      // Stable per member and voucher: a repeat resumes the same claim instead of starting another.
      const idempotencyKey = `${config.runId}-${memberId}-${config.voucherId}`;
      const claim = await merchant.claimVoucher(config.voucherId, { organizationEndUserId: memberId, idempotencyKey });
      for (const [id, handoff] of handoffs) if (handoff.expiresAt <= Date.now()) handoffs.delete(id);
      if (claim.status === 'RESERVED' && claim.digest && claim.transactionBytes) {
        handoffs.set(claim.voucherOwnershipId, { memberId, claim, expiresAt: Date.now() + 10 * 60 * 1000 });
      }
      return { json: claim };
    },
    'POST /api/claim/finalize': async (request) => {
      const { ownershipId, signature } = await readJson(request);
      const claim = await ownClaim(request, ownershipId);
      if (claim.status === 'AVAILABLE') return { json: claim };
      const handoff = handoffFor(ownershipId, claim.organizationEndUserId);
      if (claim.status !== 'RESERVED' || !handoff || typeof signature !== 'string' || !signature) {
        throw Object.assign(new Error('Reserved claim and customer signature required'), { status: 400 });
      }
      // Use only Core's original handoff for this owner; never a caller-supplied digest.
      await merchant.finalizeVoucherClaim({ digest: handoff.digest, signature });
      const finalized = await merchant.getVoucherClaim(ownershipId);
      if (finalized.status !== 'RESERVED') handoffs.delete(ownershipId);
      return { json: finalized };
    },
    'POST /api/claim/redeem': async (request) => {
      const { ownershipId } = await readJson(request);
      const claim = await ownClaim(request, ownershipId);
      if (claim.status !== 'AVAILABLE' && claim.status !== 'REDEEMED') {
        throw Object.assign(new Error('Wait for chain confirmation before redeeming'), { status: 409 });
      }
      return { json: await merchant.redeemVoucher({ serialCode: claim.serialCode }) };
    },
    'POST /api/claim/state': async (request) => {
      const memberId = await verifiedMember(request);
      const { ownershipId } = await readJson(request);
      const claim = await merchant.getVoucherClaim(ownershipId);
      // Your API key can read every member's claims, and a claim holds a redeemable serial code.
      if (claim.organizationEndUserId !== memberId) {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }
      return { json: claim };
    },
  };

  return async (request, response) => {
    const route = routes[`${request.method} ${new URL(request.url, 'http://localhost').pathname}`];
    try {
      if (!route) throw Object.assign(new Error('Not found'), { status: 404 });
      const { type, body, json } = await route(request);
      response.writeHead(200, { 'content-type': json ? 'application/json' : type });
      response.end(json ? JSON.stringify(json) : body);
    } catch (error) {
      const status =
        error instanceof OctaApiError ? error.statusCode : error instanceof SyntaxError ? 400 : (error.status ?? 500);
      // Only fixed, known business messages may reach the page. Never echo a raw Core body.
      const businessMessages = new Set([
        'Insufficient points',
        'Voucher has already been claimed by this member',
        'Member has no linked Sui address',
      ]);
      const message =
        error instanceof OctaApiError
          ? businessMessages.has(error.message)
            ? error.message
            : status === 401
              ? 'Core rejected authentication. Sign in again.'
              : status === 403
                ? 'Core rejected access for this account or merchant credential.'
                : status < 500
                  ? 'Core rejected this request. Check the existing claim state.'
                  : 'Core request failed. Inspect persisted state before retrying.'
          : status >= 500
            ? 'Core request failed. Inspect persisted state before retrying.'
            : error.message;
      console.warn(
        `Example request failed: ${request.method} ${new URL(request.url, 'http://localhost').pathname} HTTP ${status}: ${message}`,
      );
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message }));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const merchant = createOctaPointClient({
    baseUrl: config.apiBaseUrl,
    organizationId: config.organizationId,
    credentials: { apiKey: config.apiKey },
  });
  const page = { html: await readFile(new URL('index.html', here), 'utf8'), script: await bundlePage() };
  createServer(createHandler(config, merchant, page)).listen(config.port, '127.0.0.1', () => {
    console.log(`Open http://localhost:${config.port}`);
  });
}
