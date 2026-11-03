// A local test harness for @octap/browser-sdk. Plays a merchant's frontend host and backend; never
// deploy it. The API key stays in this process and only reaches Core.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOctaPointClient } from '@octap/sdk';
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
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createHandler(config, merchant, page) {
  /** The check every merchant route starts with: never trust a member ID the page sends. */
  async function verifiedMember(request) {
    const idToken = request.headers.authorization?.replace(/^Bearer /, '');
    const customer = await merchant.verifyCustomer(idToken ?? '');
    if (!customer.memberId || !customer.active) throw Object.assign(new Error('Not an active member'), { status: 403 });
    return customer.memberId;
  }

  const routes = {
    'GET /': async () => ({ type: 'text/html', body: page.html }),
    'GET /app.js': async () => ({ type: 'text/javascript', body: page.script }),
    'GET /config': async () => ({
      json: {
        apiBaseUrl: config.apiBaseUrl,
        organizationId: config.organizationId,
        googleClientId: config.googleClientId,
      },
    }),
    'POST /api/claim': async (request) => {
      const memberId = await verifiedMember(request);
      // Stable per member and voucher: a repeat resumes the same claim instead of starting another.
      const idempotencyKey = `${config.runId}-${memberId}-${config.voucherId}`;
      return {
        json: await merchant.claimVoucher(config.voucherId, { organizationEndUserId: memberId, idempotencyKey }),
      };
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
      response.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: error.message }));
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
