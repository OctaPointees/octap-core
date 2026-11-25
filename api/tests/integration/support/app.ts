import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module.js';
import { EnokiClient } from '#infra/clients/enoki/enoki.client.js';
import { drainRequestLogWrites } from '#domain/developer/request-log.middleware.js';
import { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { DRIZZLE_DB, type DrizzleDb } from '#infra/db/postgres.provider.js';

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
    claimVoucherMoveCallTarget: '0xpkg::credit_account::claim_voucher',
    useVoucherMoveCallTarget: '0xpkg::credit_account::use_voucher',
    buildRedeemTransactionKind: vi.fn(async () => new Uint8Array([1, 2, 3])),
    buildClaimVoucherTransactionKind: vi.fn(async () => new Uint8Array([4, 5, 6])),
    buildUseVoucherTransactionKind: vi.fn(async () => new Uint8Array([7, 8, 9])),
    // A real `claim_voucher` emits `VoucherClaimed` with the issue time Core counts the deadline from.
    // A plain POS `redeem` doesn't, but Core ignores the event when the debit bought no voucher.
    waitForTransaction: vi.fn(async (digest: string) => ({
      digest,
      status: 'success' as const,
      events: [
        { type: '0xpkg::credit_account::VoucherClaimed', parsedJson: { issued_at_ms: String(Date.now()) } },
      ] as Array<{ type: string; parsedJson: unknown }>,
    })),
    budgetShardRemaining: vi.fn<(shardId: string) => Promise<bigint>>(async () => 1_000_000n),
    creditAccountSpendable: vi.fn<(accountId: string) => Promise<bigint | null>>(async () => 0n),
    policyVersionDetails: vi.fn<(policyVersionId: string) => Promise<unknown>>(async () => ({
      version: 1n,
      earnBps: 100n,
      expiryMs: 30n * 24n * 60n * 60n * 1000n,
      publishedDigest: 'POLICY-DIGEST',
      publishedAtMs: Date.parse('2026-11-01T00:00:00Z'),
    })),
    latestCheckpoint: vi.fn<() => Promise<bigint>>(async () => 1_000n),
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
 * Boots the real `AppModule` exactly as `main.ts` does, against the integration Postgres/Redis, with
 * only the chain adapters replaced.
 */
export async function createTestApp(
  adapters: ChainAdapters = fakeChainAdapters(),
  google?: Pick<GoogleIdentityClient, 'verify'>,
  beforeInit?: (app: INestApplication) => void,
  /** More providers to replace, e.g. a vendor client a test fakes. */
  overrides: Array<{ provide: unknown; useValue: unknown }> = [],
) {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EnokiClient)
    .useValue(adapters.enoki)
    .overrideProvider(SuiTransactionBuilderClient)
    .useValue(adapters.suiBuilder);
  if (google) builder.overrideProvider(GoogleIdentityClient).useValue(google);
  for (const { provide, useValue } of overrides) builder.overrideProvider(provide).useValue(useValue);
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  beforeInit?.(app);
  await app.init();
  return {
    app,
    adapters,
    db: app.get<DrizzleDb>(DRIZZLE_DB),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await drainRequestLogWrites();
      await app.close();
    },
  };
}
