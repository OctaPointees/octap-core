import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module.js';
import { EnokiClient } from '../../../src/infra/clients/enoki/enoki.client.js';
import { SuiTransactionBuilderClient } from '../../../src/infra/clients/sui/sui-transaction-builder.client.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../../src/infra/db/postgres.provider.js';
import { hashApiKey } from '../../../src/infra/auth/api-key-hash.util.js';
import { buildCanonicalRequest, signCanonicalRequest } from '../../../src/infra/auth/request-signing.util.js';

/** Stand-ins for the two external services the HTTP process talks to; everything else is real. */
export function fakeChainAdapters() {
  const enoki = {
    resolveZkLoginAddress: vi.fn<(jwt: string) => Promise<{ address: string; publicKey: string; salt: string }>>(
      async () => ({ address: '0xzklogin', publicKey: 'pk', salt: 'salt' }),
    ),
    createZkLoginNonce: vi.fn(async () => ({
      nonce: 'nonce',
      randomness: 'rand',
      epoch: 1,
      maxEpoch: 3,
      estimatedExpiration: 0,
    })),
    createZkLoginProof: vi.fn(async () => ({ proofPoints: { a: [], b: [], c: [] } })),
    createSponsoredTransaction: vi.fn(async () => ({ bytes: 'sponsored-bytes', digest: 'SPONSORED-DIGEST' })),
    executeSponsoredTransaction: vi.fn(async ({ digest }: { digest: string }) => ({ digest })),
  };
  const suiBuilder = {
    redeemMoveCallTarget: '0xpkg::credit_account::redeem',
    buildRedeemTransactionKind: vi.fn(async () => new Uint8Array([1, 2, 3])),
    waitForTransaction: vi.fn(async (digest: string) => ({ digest, status: 'success' as const, events: [] })),
    listCreditAccountEvents: vi.fn(async () => ({
      events: [],
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    })),
  };
  return { enoki, suiBuilder };
}

export type ChainAdapters = ReturnType<typeof fakeChainAdapters>;

/**
 * Boots the real `AppModule` exactly as `main.ts` does (`rawBody: true`, so request signing hashes
 * the bytes actually sent), against the integration Postgres/Redis, with only the chain adapters
 * replaced.
 */
export async function createTestApp(adapters: ChainAdapters = fakeChainAdapters()) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EnokiClient)
    .useValue(adapters.enoki)
    .overrideProvider(SuiTransactionBuilderClient)
    .useValue(adapters.suiBuilder)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  return {
    app,
    adapters,
    db: app.get<DrizzleDb>(DRIZZLE_DB),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

let nonceSeq = 0;

/** Headers for a `@RequireSignedRequest()` route, signed the way an SDK client would sign them. */
export function signedHeaders(rawKey: string, method: string, path: string, body: unknown = undefined) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-${Date.now()}-${++nonceSeq}`;
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const canonical = buildCanonicalRequest({ method, path, timestamp, nonce, rawBody });
  return {
    authorization: `Bearer ${rawKey}`,
    'x-octap-timestamp': timestamp,
    'x-octap-nonce': nonce,
    'x-octap-signature': signCanonicalRequest(canonical, hashApiKey(rawKey)),
  };
}
