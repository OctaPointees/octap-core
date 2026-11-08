import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ChainSubmitProcessor } from '#domain/credits/chain-submit.processor.js';
import { CheckpointIndexerProcessor } from '#domain/indexer/checkpoint-indexer.processor.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { IndexerRepository, CREDIT_ACCOUNT_STREAM } from '#infra/db/repositories/indexer.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { createTestApp } from '../support/app.js';
import {
  getOwnership,
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
} from '../support/db.js';
import { stub } from '../../helpers/stub.js';
import { POS_BENEFIT, b64, fakeChainResult } from '../../helpers/fixtures.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;
let memberId: string;
let auth: { authorization: string };
const BUCKET_EXPIRY_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
  ctx = await createTestApp();
});

beforeEach(async () => {
  await resetDb(ctx.db);
  orgId = (await seedOrganization(ctx.db)).id;
  await seedProgram(ctx.db, orgId);
  memberId = (await seedMember(ctx.db, orgId, { suiAddress: '0xbeneficiary' })).memberId;
  auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
});

afterAll(async () => {
  await ctx.close();
});

/**
 * The worker's half of an earn, wired to the app's real repositories: the chain double opens an
 * account and credits 1% of the purchase amount (the seeded program's 100 bps), like testnet does.
 */
function chainSubmitWorker(
  earn = async (_program: unknown, params: { purchaseAmount: number }) =>
    fakeChainResult({
      digest: `EARN-${params.purchaseAmount}-${Math.random()}`,
      events: [
        {
          type: '0xpkg::credit_account::CreditEarned',
          parameters: undefined,
          parsedJson: { amount: String(params.purchaseAmount / 100), bucket_expires_at_ms: String(BUCKET_EXPIRY_MS) },
        } as never,
      ],
    }),
) {
  const operations = ctx.app.get(OperationsRepository);
  const processor = new ChainSubmitProcessor(
    operations,
    ctx.app.get(CreditsRepository),
    stub<SuiClientService>({
      issuerAddress: () => '0xissuer',
      openAccount: async () =>
        fakeChainResult({
          digest: 'OPEN',
          events: [{ type: '0xpkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xacc' } }],
        }),
      signEarn: async (program: unknown, params: { purchaseAmount: number }) => ({
        program,
        params,
        digest: 'SIGNED',
        expirationEpoch: 1n,
      }),
      execute: async (signed: { program: unknown; params: { purchaseAmount: number } }) =>
        earn(signed.program, signed.params),
    }),
    ctx.app.get(ProgramsRepository),
    ctx.app.get(RewardsRepository),
  );
  return {
    async drain() {
      for (const op of await operations.claimNextPending(['CREDIT_EARN_CHAIN_SUBMIT'], 10)) {
        await processor.process(op);
      }
    },
  };
}

const earn = (purchaseAmount: number, idempotencyKey: string) =>
  ctx
    .http()
    .post('/v1/credits/earn')
    .set(auth)
    .send({ organizationEndUserId: memberId, purchaseAmount, idempotencyKey });
const balance = async () =>
  (await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(auth).expect(200)).body;

describe('earn -> chain confirmation -> balance -> reverse', () => {
  it('keeps purchase units separate through acceptance, history, confirmation and reversal', async () => {
    const accepted = await earn(100_000, 'receipt-001').expect(201);
    expect(accepted.body).toMatchObject({
      status: 'PENDING',
      purchaseAmount: 100_000,
      estimatedPoints: 1000,
      pointsEarned: null,
      newBalance: 0,
    });
    expect(await balance()).toMatchObject({ confirmedBalance: 0, pendingEarn: 1000, stale: true });
    const pending = (await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(auth).expect(200))
      .body[0];
    expect(pending).toMatchObject({ purchaseAmount: 100_000, estimatedPoints: 1000, pointsAmount: null });
    expect((await earn(100_000, 'receipt-001').expect(201)).body.transactionId).toBe(accepted.body.transactionId);
    await earn(100_001, 'receipt-001').expect(409);
    await chainSubmitWorker().drain();
    expect(await balance()).toMatchObject({
      confirmedBalance: 1000,
      pendingEarn: 0,
      lifetimeEarned: 1000,
      stale: false,
    });
    expect((await earn(100_000, 'receipt-001').expect(201)).body).toMatchObject({
      pointsEarned: 1000,
      estimatedPoints: null,
    });
    const history = (await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(auth).expect(200)).body;
    expect(history[0]).toMatchObject({ pointsAmount: 1000, purchaseAmount: 100_000, status: 'CONFIRMED' });
    await ctx
      .http()
      .post('/v1/credits/redeem')
      .set(auth)
      .send({ organizationEndUserId: memberId, pointsAmount: 40, idempotencyKey: 'unsigned' })
      .expect(404);
    expect(await balance()).toMatchObject({ confirmedBalance: 1000 });
    const reversed = await ctx
      .http()
      .post(`/v1/credits/transactions/${accepted.body.transactionId}/reverse`)
      .set(auth)
      .send({ idempotencyKey: 'reverse-1', reason: 'chargeback' })
      .expect(201);
    expect(reversed.body).toMatchObject({ pointsAmount: 1000, newBalance: 0, balanceWentNegative: false });
  });

  it('a definitive on-chain failure releases the hold', async () => {
    await earn(500, 'e-fail').expect(201);
    await chainSubmitWorker(async () =>
      fakeChainResult({ status: 'failure', errorMessage: 'EBudgetExhausted' }),
    ).drain();

    expect(await balance()).toMatchObject({ confirmedBalance: 0, pendingEarn: 0 });
    const [op] = await ctx.db.select().from(schema.operations).where(eq(schema.operations.idempotencyKey, 'e-fail'));
    expect(op).toMatchObject({ status: 'FAILED', errorMessage: 'EBudgetExhausted' });
  });

  it('an outcome-unknown earn stays held until the indexer confirms it from the chain event', async () => {
    const accepted = await earn(10_000, 'e-unknown').expect(201);
    await chainSubmitWorker(async () => {
      throw new Error('DEADLINE_EXCEEDED');
    }).drain();
    const ownership = await getOwnership(ctx.db, memberId);
    expect(ownership).toMatchObject({ pendingEarn: 100, confirmedBalance: 0, suiCreditAccountId: '0xacc' });

    const indexerRepo = ctx.app.get(IndexerRepository);
    await indexerRepo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '1');
    const indexer = new CheckpointIndexerProcessor(
      indexerRepo,
      ctx.app.get(CreditsRepository),
      ctx.app.get(OperationsRepository),
      stub<SuiTransactionBuilderClient>({
        listCreditAccountEvents: async () => ({
          events: [
            {
              name: 'CreditEarned',
              sender: '0xissuer',
              json: {
                account_id: '0xacc',
                amount: '100',
                operation_key: b64('e-unknown'),
                bucket_expires_at_ms: String(BUCKET_EXPIRY_MS),
              },
              checkpoint: '42',
              transactionDigest: 'D-FROM-CHAIN',
              eventIndex: 0,
            },
          ],
          hasNextPage: false,
          startCursor: 'C1',
          endCursor: 'C1',
        }),
      }),
      ctx.app.get(RewardsRepository),
    );

    expect(await indexer.processNextPage()).toBe(false);

    expect(await balance()).toMatchObject({ confirmedBalance: 100, pendingEarn: 0, asOfCheckpoint: '42' });
    const [op] = await ctx.db.select().from(schema.operations).where(eq(schema.operations.idempotencyKey, 'e-unknown'));
    expect(op).toMatchObject({ status: 'SUBMITTED', suiTxDigest: 'D-FROM-CHAIN' });
    const [tx] = await ctx.db
      .select()
      .from(schema.loyaltyTransactions)
      .where(eq(schema.loyaltyTransactions.id, accepted.body.transactionId));
    expect(tx.status).toBe('CONFIRMED');
  });

  it('validates bodies, and hides another organization’s members and transactions', async () => {
    await ctx.http().post('/v1/credits/earn').set(auth).send({ organizationEndUserId: memberId }).expect(400);
    await earn(0, 'zero').expect(400);

    const other = await seedOrganization(ctx.db);
    const { memberId: foreign } = await seedMember(ctx.db, other.id);
    await ctx.http().get(`/v1/credits/members/${foreign}/balance`).set(auth).expect(404);
    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: foreign, purchaseAmount: 1, idempotencyKey: 'x' })
      .expect(404);
    await ctx
      .http()
      .post('/v1/credits/transactions/00000000-0000-0000-0000-000000000000/reverse')
      .set(auth)
      .send({ idempotencyKey: 'k', reason: 'r' })
      .expect(404);
  });

  it('an organization without a provisioned program gets 422 on earn and POS reserve, and nothing is held', async () => {
    const bare = await seedOrganization(ctx.db);
    const { memberId: bareMember } = await seedMember(ctx.db, bare.id);
    const bareAuth = {
      authorization: `Bearer ${(await seedCredential(ctx.db, bare.id, { scopes: ['read', 'write'] })).rawKey}`,
    };

    const earnRes = await ctx
      .http()
      .post('/v1/credits/earn')
      .set(bareAuth)
      .send({ organizationEndUserId: bareMember, purchaseAmount: 100, idempotencyKey: 'bare-earn' })
      .expect(422);
    expect(earnRes.body.message).toMatch(/has no on-chain program provisioned \(no programs row\)/);
    await ctx
      .http()
      .post('/v1/credits/redeem/reserve')
      .set(bareAuth)
      .send({ organizationEndUserId: bareMember, pointsAmount: 1, idempotencyKey: 'bare-reserve', ...POS_BENEFIT })
      .expect(422);

    expect(
      await ctx.db
        .select()
        .from(schema.loyaltyTransactions)
        .where(eq(schema.loyaltyTransactions.organizationId, bare.id)),
    ).toEqual([]);
    expect(await ctx.db.select().from(schema.operations).where(eq(schema.operations.tenantId, bare.id))).toEqual([]);
  });
});

describe('POS redemption: reserve -> customer signs -> finalize', () => {
  beforeEach(async () => {
    await earn(10_000, 'seed-earn').expect(201);
    await chainSubmitWorker().drain();
  });

  const reserve = (pointsAmount: number, idempotencyKey = 'pos-1') =>
    ctx
      .http()
      .post('/v1/credits/redeem/reserve')
      .set(auth)
      .send({ organizationEndUserId: memberId, pointsAmount, idempotencyKey, ...POS_BENEFIT });

  it('holds, sponsors, and settles on the chain’s verdict; finalize needs no merchant key', async () => {
    const reserved = await reserve(30).expect(201);
    expect(reserved.body).toMatchObject({
      status: 'PENDING',
      digest: 'SPONSORED-DIGEST',
      transactionBytes: 'sponsored-bytes',
    });
    expect(ctx.adapters.enoki.createSponsoredTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ sender: '0xbeneficiary', allowedMoveCallTargets: ['0xpkg::credit_account::redeem'] }),
    );
    expect(await balance()).toMatchObject({ confirmedBalance: 100, pendingRedemption: 30 });

    // Retried by the POS: same hold, cached bytes, no second sponsorship.
    ctx.adapters.enoki.createSponsoredTransaction.mockClear();
    expect((await reserve(30).expect(201)).body.digest).toBe('SPONSORED-DIGEST');
    expect(ctx.adapters.enoki.createSponsoredTransaction).not.toHaveBeenCalled();
    await reserve(31).expect(409);

    const finalized = await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: 'SPONSORED-DIGEST', signature: 'customer-sig' })
      .expect(201);
    expect(finalized.body).toMatchObject({
      status: 'CONFIRMED',
      pointsRedeemed: 30,
      newBalance: 70,
      blockchainDigest: 'SPONSORED-DIGEST',
    });
    expect(await balance()).toMatchObject({ confirmedBalance: 70, pendingRedemption: 0, lifetimeRedeemed: 30 });

    // The reservation is consumed.
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: 'SPONSORED-DIGEST', signature: 'customer-sig' })
      .expect(404);
    expect((await reserve(30).expect(201)).body).toMatchObject({ status: 'CONFIRMED', digest: null });
  });

  it('a failed on-chain redeem releases the hold', async () => {
    ctx.adapters.enoki.createSponsoredTransaction.mockResolvedValueOnce({ bytes: 'b', digest: 'FAIL-DIGEST' });
    ctx.adapters.suiBuilder.waitForTransaction.mockResolvedValueOnce({
      digest: 'FAIL-DIGEST',
      status: 'failure',
      errorMessage: 'ENotBeneficiary',
    } as never);
    await reserve(30, 'pos-fail').expect(201);

    const res = await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: 'FAIL-DIGEST', signature: 'sig' })
      .expect(400);

    expect(res.body.message).toBe('ENotBeneficiary');
    expect(await balance()).toMatchObject({ confirmedBalance: 100, pendingRedemption: 0 });
  });

  it('refuses holds beyond the available balance and incomplete bodies', async () => {
    await reserve(101).expect(400);
    await ctx.http().post('/v1/credits/redeem/reserve').set(auth).send({}).expect(400);
    await ctx.http().post('/v1/credits/redeem/finalize').send({ digest: 'x' }).expect(400);
  });
});
