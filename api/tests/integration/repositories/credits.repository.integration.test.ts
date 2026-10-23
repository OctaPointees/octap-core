import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { CreditsRepository, expireDueBuckets } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import {
  connectTestDb,
  getLoyaltyTransaction,
  getOwnership,
  insertLoyaltyTransaction,
  resetDb,
  schema,
  seedMember,
  seedOrganization,
  setOwnership,
} from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new CreditsRepository(db);

const DAY_MS = 24 * 60 * 60 * 1000;
let digestSeq = 0;
const nextDigest = () => `DIGEST-${++digestSeq}`;

let orgId: string;
let memberId: string;

beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
  memberId = (await seedMember(db, orgId, { suiAddress: '0xbeneficiary' })).memberId;
});

afterAll(async () => {
  await client.end();
});

/** Earn + chain confirmation, the way the chain-submit worker resolves it. */
async function confirmedEarn(amount: number, { expiresInMs = 30 * DAY_MS, key = `earn-${amount}-${digestSeq}` } = {}) {
  const { transaction } = await repo.recordEarnTransaction({
    organizationId: orgId,
    organizationEndUserId: memberId,
    pointsAmount: amount,
    idempotencyKey: key,
  });
  await repo.confirmEarnOnChain({
    loyaltyTransactionId: transaction.id,
    organizationEndUserId: memberId,
    reservedPointsAmount: amount,
    confirmedPointsAmount: amount,
    bucketExpiresAtMs: expiresInMs === null ? null : Date.now() + expiresInMs,
    digest: nextDigest(),
    sender: '0xissuer',
  });
  return transaction;
}

async function bucketsOf(member = memberId) {
  const ownership = await getOwnership(db, member);
  return db
    .select()
    .from(schema.creditBuckets)
    .where(eq(schema.creditBuckets.creditOwnershipId, ownership.id))
    .orderBy(schema.creditBuckets.expiresAtMs);
}

describe('membership lookups', () => {
  it('resolves a member’s organization and zkLogin address, and null for unknown/addressless members', async () => {
    expect(await repo.findMemberOrganizationId(memberId)).toBe(orgId);
    expect(await repo.findBeneficiaryAddress(memberId)).toBe('0xbeneficiary');

    const ghost = '00000000-0000-0000-0000-000000000000';
    expect(await repo.findMemberOrganizationId(ghost)).toBeNull();
    expect(await repo.findBeneficiaryAddress(ghost)).toBeNull();

    const { memberId: noAddress } = await seedMember(db, orgId, { withAddress: false });
    expect(await repo.findBeneficiaryAddress(noAddress)).toBeNull();
  });

  it('getOrCreateCreditOwnership creates a zeroed row once', async () => {
    const created = await repo.getOrCreateCreditOwnership(memberId);
    expect(created).toMatchObject({ confirmedBalance: 0, pendingEarn: 0, pendingRedemption: 0 });
    expect((await repo.getOrCreateCreditOwnership(memberId)).id).toBe(created.id);
    expect((await repo.getCreditOwnershipByEndUserId(memberId))?.id).toBe(created.id);
  });
});

describe('earn', () => {
  it('records a PENDING earn, bumps pendingEarn, and enqueues the chain-submit command in the same transaction', async () => {
    const { transaction, newBalance } = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 10_000,
      idempotencyKey: 'earn-1',
      receiptReference: 'receipt-1',
      metadata: { store: 'A' },
    });

    expect(newBalance).toBe(0);
    expect(transaction).toMatchObject({
      status: 'PENDING',
      transactionType: 'EARN',
      pointsAmount: 10_000,
      receiptReference: 'receipt-1',
    });
    expect(await getOwnership(db, memberId)).toMatchObject({ pendingEarn: 10_000, confirmedBalance: 0 });

    const [operation] = await db.select().from(schema.operations).where(eq(schema.operations.idempotencyKey, 'earn-1'));
    expect(operation).toMatchObject({
      tenantId: orgId,
      commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
      status: 'PENDING',
      payload: { loyaltyTransactionId: transaction.id, organizationEndUserId: memberId, pointsAmount: 10_000 },
    });
    expect(operation.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await repo.findTransactionByIdempotency(orgId, 'earn-1'))?.id).toBe(transaction.id);
    expect((await repo.findTransactionByMemberAndIdempotency(memberId, 'earn-1'))?.id).toBe(transaction.id);
  });

  it('a duplicate idempotency key is rejected by the unique index and leaves nothing half-written', async () => {
    await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 10,
      idempotencyKey: 'dup',
    });
    await expect(
      repo.recordEarnTransaction({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 10,
        idempotencyKey: 'dup',
      }),
    ).rejects.toThrow();
    expect(await getOwnership(db, memberId)).toMatchObject({ pendingEarn: 10 });
  });

  it('confirmEarnOnChain moves the hold into the confirmed balance at the chain’s amount and records a bucket', async () => {
    const { transaction } = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 10_000,
      idempotencyKey: 'e',
    });
    const expiresAtMs = Date.now() + DAY_MS;

    const receipt = await repo.confirmEarnOnChain({
      loyaltyTransactionId: transaction.id,
      organizationEndUserId: memberId,
      reservedPointsAmount: 10_000,
      confirmedPointsAmount: 100,
      bucketExpiresAtMs: expiresAtMs,
      digest: 'D-EARN',
      sender: '0xissuer',
    });

    expect(receipt).toMatchObject({ digest: 'D-EARN', status: 'CONFIRMED', sender: '0xissuer' });
    expect(await getLoyaltyTransaction(db, transaction.id)).toMatchObject({
      status: 'CONFIRMED',
      pointsAmount: 100,
      blockchainTransactionId: receipt!.id,
    });
    expect(await getOwnership(db, memberId)).toMatchObject({
      confirmedBalance: 100,
      pendingEarn: 0,
      lifetimeEarned: 100,
    });
    expect(await bucketsOf()).toMatchObject([
      { earnTransactionId: transaction.id, amount: 100, remaining: 100, expiresAtMs },
    ]);

    const [listed] = await repo.listTransactionsByMember(orgId, memberId);
    expect(listed.blockchainTransaction?.digest).toBe('D-EARN');
  });

  it('confirming twice (sync path vs. indexer) applies the balance effect exactly once', async () => {
    const { transaction } = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 50,
      idempotencyKey: 'e',
    });
    const confirm = (digest: string) =>
      repo.confirmEarnOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        reservedPointsAmount: 50,
        confirmedPointsAmount: 50,
        bucketExpiresAtMs: null,
        digest,
        sender: '0xissuer',
      });

    // Concurrent: the row lock lets exactly one through.
    const results = await Promise.all([confirm('D-A'), confirm('D-B')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await confirm('D-C')).toBeNull();
    expect(await getOwnership(db, memberId)).toMatchObject({
      confirmedBalance: 50,
      pendingEarn: 0,
      lifetimeEarned: 50,
    });
    expect(await bucketsOf()).toEqual([]);
  });

  it('two different earns of one member confirming at once lose no delta (ownership row lock)', async () => {
    const a = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 30,
      idempotencyKey: 'a',
    });
    const b = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 70,
      idempotencyKey: 'b',
    });
    const confirm = (tx: typeof a.transaction, amount: number, digest: string) =>
      repo.confirmEarnOnChain({
        loyaltyTransactionId: tx.id,
        organizationEndUserId: memberId,
        reservedPointsAmount: amount,
        confirmedPointsAmount: amount,
        bucketExpiresAtMs: null,
        digest,
        sender: '0xissuer',
      });

    await Promise.all([confirm(a.transaction, 30, 'D-A'), confirm(b.transaction, 70, 'D-B')]);

    expect(await getOwnership(db, memberId)).toMatchObject({
      confirmedBalance: 100,
      pendingEarn: 0,
      lifetimeEarned: 100,
    });
  });

  it('failEarnOnChain releases the hold once and marks the row FAILED', async () => {
    const { transaction } = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 40,
      idempotencyKey: 'e',
    });
    const fail = () =>
      repo.failEarnOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        reservedPointsAmount: 40,
      });

    await fail();
    await fail();

    expect((await getLoyaltyTransaction(db, transaction.id)).status).toBe('FAILED');
    expect(await getOwnership(db, memberId)).toMatchObject({ pendingEarn: 0, confirmedBalance: 0 });
  });

  it('a confirm after a fail is a no-op (the row is no longer PENDING)', async () => {
    const { transaction } = await repo.recordEarnTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 40,
      idempotencyKey: 'e',
    });
    await repo.failEarnOnChain({
      loyaltyTransactionId: transaction.id,
      organizationEndUserId: memberId,
      reservedPointsAmount: 40,
    });

    expect(
      await repo.confirmEarnOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        reservedPointsAmount: 40,
        confirmedPointsAmount: 40,
        bucketExpiresAtMs: null,
        digest: 'D',
        sender: 's',
      }),
    ).toBeNull();
  });

  it('stores and resolves the on-chain account id', async () => {
    const ownership = await repo.getOrCreateCreditOwnership(memberId);
    await repo.setSuiCreditAccountId(ownership.id, '0xacc');
    expect((await repo.findCreditOwnershipBySuiAccountId('0xacc'))?.organizationEndUserId).toBe(memberId);
  });
});

describe('Postgres-only redeem', () => {
  it('debits the confirmed balance and consumes buckets nearest-expiry first', async () => {
    await confirmedEarn(100, { expiresInMs: 10 * DAY_MS });
    await confirmedEarn(50, { expiresInMs: 2 * DAY_MS });

    const { transaction, newBalance } = await repo.recordRedeemTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 70,
      idempotencyKey: 'r-1',
    });

    expect(newBalance).toBe(80);
    expect(transaction).toMatchObject({ transactionType: 'REDEEM', status: 'CONFIRMED', pointsAmount: 70 });
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 80, lifetimeRedeemed: 70 });
    expect((await bucketsOf()).map((b) => b.remaining)).toEqual([0, 80]);
  });

  it('rejects an amount above the balance, including for a member with no ownership row yet', async () => {
    await expect(
      repo.recordRedeemTransaction({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 1,
        idempotencyKey: 'r',
      }),
    ).rejects.toThrow(/Insufficient points: required 1, available 0/);

    await confirmedEarn(10);
    await expect(
      repo.recordRedeemTransaction({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 11,
        idempotencyKey: 'r',
      }),
    ).rejects.toThrow(/available 10/);
  });

  it('expires due buckets before checking the balance', async () => {
    await confirmedEarn(100, { expiresInMs: -1000 });

    await expect(
      repo.recordRedeemTransaction({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 50,
        idempotencyKey: 'r',
      }),
    ).rejects.toThrow(/available 0/);
  });
});

describe('POS redemption', () => {
  beforeEach(async () => {
    await confirmedEarn(100);
    const ownership = await getOwnership(db, memberId);
    await repo.setSuiCreditAccountId(ownership.id, '0xacc');
  });

  const reserve = (pointsAmount: number, idempotencyKey = 'pos-1') =>
    repo.reservePosRedemption({ organizationId: orgId, organizationEndUserId: memberId, pointsAmount, idempotencyKey });

  it('holds the amount in pendingRedemption and records a PENDING redeem + command', async () => {
    const { transaction, accountId, isNew } = await reserve(30);

    expect(isNew).toBe(true);
    expect(accountId).toBe('0xacc');
    expect(transaction).toMatchObject({ status: 'PENDING', transactionType: 'REDEEM', pointsAmount: 30 });
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 30 });
    const [operation] = await db
      .select()
      .from(schema.operations)
      .where(and(eq(schema.operations.tenantId, orgId), eq(schema.operations.idempotencyKey, 'pos-1')));
    expect(operation.commandType).toBe('CREDIT_POS_REDEEM_RESERVE');
  });

  it('replays the same key+payload without a second hold, and rejects a changed payload', async () => {
    const first = await reserve(30);
    const replay = await reserve(30);

    expect(replay).toMatchObject({ isNew: false, accountId: '0xacc' });
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect((await getOwnership(db, memberId)).pendingRedemption).toBe(30);
    await expect(reserve(31)).rejects.toThrow(OperationPayloadConflictError);
  });

  it('a replay reports the digest a finalize already sent for the hold (OCT-52), so no fresh bytes are sponsored', async () => {
    expect((await reserve(30)).submittedDigest).toBeNull();
    expect((await reserve(30)).submittedDigest).toBeNull();

    await db
      .update(schema.operations)
      .set({ suiTxDigest: 'D-SENT' })
      .where(and(eq(schema.operations.tenantId, orgId), eq(schema.operations.idempotencyKey, 'pos-1')));

    expect(await reserve(30)).toMatchObject({ isNew: false, submittedDigest: 'D-SENT' });
  });

  it('available = confirmed - already held; concurrent reserves can’t both spend the same points', async () => {
    const results = await Promise.allSettled([reserve(60, 'pos-a'), reserve(60, 'pos-b')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { message: expect.stringMatching(/Insufficient points: required 60, available 40/) },
    });
    expect((await getOwnership(db, memberId)).pendingRedemption).toBe(60);
  });

  it('rejects a member without an on-chain account, or with no ownership at all', async () => {
    const { memberId: fresh } = await seedMember(db, orgId);
    await expect(
      repo.reservePosRedemption({
        organizationId: orgId,
        organizationEndUserId: fresh,
        pointsAmount: 1,
        idempotencyKey: 'x',
      }),
    ).rejects.toThrow(/available 0/);

    await setOwnership(db, fresh, { confirmedBalance: 10 });
    await expect(
      repo.reservePosRedemption({
        organizationId: orgId,
        organizationEndUserId: fresh,
        pointsAmount: 1,
        idempotencyKey: 'y',
      }),
    ).rejects.toThrow(/no on-chain CreditAccount yet/);
  });

  it('a replay whose loyalty row went missing is reported, not silently re-held', async () => {
    const { transaction } = await reserve(10);
    await db.delete(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.id, transaction.id));

    await expect(reserve(10)).rejects.toThrow(/already accepted but its loyalty transaction is missing/);
  });

  it('confirm moves the hold out of the balance once and consumes buckets', async () => {
    const { transaction } = await reserve(30);
    const confirm = (digest: string) =>
      repo.confirmPosRedemptionOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        pointsAmount: 30,
        digest,
        sender: '0xbeneficiary',
      });

    expect(await confirm('D-POS')).toMatchObject({ digest: 'D-POS', sender: '0xbeneficiary' });
    expect(await confirm('D-POS-2')).toBeNull();

    expect(await getLoyaltyTransaction(db, transaction.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(await getOwnership(db, memberId)).toMatchObject({
      confirmedBalance: 70,
      pendingRedemption: 0,
      lifetimeRedeemed: 30,
    });
    expect((await bucketsOf())[0].remaining).toBe(70);
  });

  it('a second confirm with the same digest hits the unique index (what finalize maps to CONFIRMED)', async () => {
    const a = await reserve(10, 'pos-a');
    const b = await reserve(10, 'pos-b');
    await repo.confirmPosRedemptionOnChain({
      loyaltyTransactionId: a.transaction.id,
      organizationEndUserId: memberId,
      pointsAmount: 10,
      digest: 'SAME',
      sender: 's',
    });

    await expect(
      repo.confirmPosRedemptionOnChain({
        loyaltyTransactionId: b.transaction.id,
        organizationEndUserId: memberId,
        pointsAmount: 10,
        digest: 'SAME',
        sender: 's',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('fail releases the hold once, leaving the balance untouched', async () => {
    const { transaction } = await reserve(30);
    const fail = () =>
      repo.failPosRedemptionOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        pointsAmount: 30,
      });

    await fail();
    await fail();

    expect((await getLoyaltyTransaction(db, transaction.id)).status).toBe('FAILED');
    expect(await getOwnership(db, memberId)).toMatchObject({ confirmedBalance: 100, pendingRedemption: 0 });
  });
});

describe('bucket expiry', () => {
  it('forfeits due buckets, records one EXPIRY row, and is idempotent', async () => {
    await confirmedEarn(40, { expiresInMs: -2000 });
    await confirmedEarn(60, { expiresInMs: -1000 });
    await confirmedEarn(25, { expiresInMs: DAY_MS });

    expect(await repo.expireDueBucketsForMember({ organizationId: orgId, organizationEndUserId: memberId })).toBe(100);
    expect(await repo.expireDueBucketsForMember({ organizationId: orgId, organizationEndUserId: memberId })).toBe(0);

    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(25);
    const expiries = await db
      .select()
      .from(schema.loyaltyTransactions)
      .where(eq(schema.loyaltyTransactions.transactionType, 'EXPIRY'));
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({ pointsAmount: 100, status: 'CONFIRMED', organizationId: orgId });
    expect((expiries[0].metadata as { bucketIds: string[] }).bucketIds).toHaveLength(2);
  });

  it('never forfeits more than the balance (no expiry debt), even with a negative balance', async () => {
    await confirmedEarn(100, { expiresInMs: -1000 });
    await setOwnership(db, memberId, { confirmedBalance: 30 });
    expect(await repo.expireDueBucketsForMember({ organizationId: orgId, organizationEndUserId: memberId })).toBe(30);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(0);

    await confirmedEarn(10, { expiresInMs: -1000 });
    await setOwnership(db, memberId, { confirmedBalance: -5 });
    expect(await repo.expireDueBucketsForMember({ organizationId: orgId, organizationEndUserId: memberId })).toBe(0);
    expect((await getOwnership(db, memberId)).confirmedBalance).toBe(-5);
  });

  it('is a no-op for a member with no ownership row', async () => {
    const { memberId: fresh } = await seedMember(db, orgId);
    expect(
      await db.transaction((tx) => expireDueBuckets(tx, { organizationId: orgId, organizationEndUserId: fresh })),
    ).toBe(0);
  });

  it('ensureEarnBucket backfills a missing bucket and trims buckets down to the balance', async () => {
    // Two earns confirmed before buckets existed; 120 of their 150 points were spent since.
    const old = await confirmedEarn(100, { expiresInMs: null as unknown as number });
    const newer = await confirmedEarn(50, { expiresInMs: null as unknown as number });
    await setOwnership(db, memberId, { confirmedBalance: 30 });

    await repo.ensureEarnBucket({
      organizationEndUserId: memberId,
      earnTransactionId: newer.id,
      amount: 50,
      expiresAtMs: Date.now() + 2 * DAY_MS,
    });
    await repo.ensureEarnBucket({
      organizationEndUserId: memberId,
      earnTransactionId: old.id,
      amount: 100,
      expiresAtMs: Date.now() + DAY_MS,
    });
    // Replaying the same event is a no-op.
    await repo.ensureEarnBucket({
      organizationEndUserId: memberId,
      earnTransactionId: old.id,
      amount: 100,
      expiresAtMs: Date.now() + DAY_MS,
    });

    // Excess is trimmed nearest-expiry first, so the remaining 30 sit in the later bucket.
    expect((await bucketsOf()).map((b) => [b.earnTransactionId, b.remaining])).toEqual([
      [old.id, 0],
      [newer.id, 30],
    ]);
  });

  it('ensureEarnBucket is a no-op for a member with no ownership row', async () => {
    const { memberId: fresh } = await seedMember(db, orgId);
    await repo.ensureEarnBucket({
      organizationEndUserId: fresh,
      earnTransactionId: '00000000-0000-0000-0000-000000000000',
      amount: 1,
      expiresAtMs: 1,
    });
    expect(await db.select().from(schema.creditBuckets)).toEqual([]);
  });
});

describe('reversal', () => {
  it('reversing a spent earn drives the balance negative and zeroes its bucket', async () => {
    const earn = await confirmedEarn(100);
    await repo.recordRedeemTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 80,
      idempotencyKey: 'r',
    });
    const original = await getLoyaltyTransaction(db, earn.id);

    const { reversal, reversedOriginal, newBalance } = await repo.recordReversalTransaction({
      organizationId: orgId,
      original,
      idempotencyKey: 'rev-1',
      reason: 'chargeback',
    });

    expect(newBalance).toBe(-80);
    expect(reversedOriginal.status).toBe('REVERSED');
    expect(reversal).toMatchObject({
      transactionType: 'REVERSAL',
      pointsAmount: 100,
      reversesTransactionId: earn.id,
      receiptReference: 'chargeback',
      metadata: { reversedTransactionType: 'EARN' },
    });
    expect((await bucketsOf()).map((b) => b.remaining)).toEqual([0]);
    expect((await repo.findReversalOf(earn.id))?.id).toBe(reversal.id);
  });

  it('reversing a redeem adds the points back', async () => {
    await confirmedEarn(100);
    const { transaction } = await repo.recordRedeemTransaction({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 40,
      idempotencyKey: 'r',
    });

    const { newBalance } = await repo.recordReversalTransaction({
      organizationId: orgId,
      original: transaction,
      idempotencyKey: 'rev',
    });

    expect(newBalance).toBe(100);
  });

  it('the unique index rejects a second reversal of the same original', async () => {
    const earn = await getLoyaltyTransaction(db, (await confirmedEarn(10)).id);
    await repo.recordReversalTransaction({ organizationId: orgId, original: earn, idempotencyKey: 'rev-1' });

    await expect(
      repo.recordReversalTransaction({ organizationId: orgId, original: earn, idempotencyKey: 'rev-2' }),
    ).rejects.toThrow();
  });

  it('fails cleanly when the member has no ownership row', async () => {
    const { memberId: fresh } = await seedMember(db, orgId);
    const orphan = await insertLoyaltyTransaction(db, {
      organizationId: orgId,
      organizationEndUserId: fresh,
      transactionType: 'EARN',
      pointsAmount: 5,
      idempotencyKey: 'orphan',
      status: 'CONFIRMED',
    });

    await expect(
      repo.recordReversalTransaction({ organizationId: orgId, original: orphan, idempotencyKey: 'rev' }),
    ).rejects.toThrow(/Credit ownership not found/);
  });
});

describe('tenant scoping', () => {
  it('lookups by id and history are scoped to the organization', async () => {
    const earn = await confirmedEarn(10);
    const other = await seedOrganization(db);

    expect((await repo.findTransactionByIdForOrganization(orgId, earn.id))?.id).toBe(earn.id);
    expect(await repo.findTransactionByIdForOrganization(other.id, earn.id)).toBeUndefined();
    expect(await repo.findTransactionByIdempotency(other.id, earn.idempotencyKey)).toBeUndefined();
    expect(await repo.listTransactionsByMember(other.id, memberId)).toEqual([]);
    expect((await repo.getLoyaltyTransactionById(earn.id))?.id).toBe(earn.id);
  });

  it('history is newest-first and honours the limit', async () => {
    await confirmedEarn(1, { key: 'a' });
    await confirmedEarn(2, { key: 'b' });
    await confirmedEarn(3, { key: 'c' });

    const history = await repo.listTransactionsByMember(orgId, memberId, 2);
    expect(history.map((t) => t.idempotencyKey)).toEqual(['c', 'b']);
  });
});

describe('chain-confirmation webhooks (OCT-209 outbox)', () => {
  const deliveries = () => db.select().from(schema.webhookDeliveries);

  beforeEach(async () => {
    await new WebhooksRepository(db).createEndpoint({
      organizationId: orgId,
      url: 'https://merchant.example/hooks',
      secret: 'whsec_1',
    });
  });

  const acceptEarn = async (key: string) =>
    (
      await repo.recordEarnTransaction({
        organizationId: orgId,
        organizationEndUserId: memberId,
        pointsAmount: 10_000,
        idempotencyKey: key,
      })
    ).transaction;
  const confirmEarn = (transactionId: string, digest: string, db_ = db) =>
    repo.confirmEarnOnChain(
      {
        loyaltyTransactionId: transactionId,
        organizationEndUserId: memberId,
        reservedPointsAmount: 10_000,
        confirmedPointsAmount: 100,
        bucketExpiresAtMs: null,
        digest,
        sender: '0xissuer',
      },
      db_,
    );

  it('a confirmed earn queues exactly one credits.earn.confirmed carrying the on-chain amount, balance and digest', async () => {
    const tx = await acceptEarn('e');

    await confirmEarn(tx.id, 'D-EARN');

    expect(await deliveries()).toMatchObject([
      {
        eventType: 'credits.earn.confirmed',
        payload: {
          transactionId: tx.id,
          organizationEndUserId: memberId,
          pointsAmount: 100,
          newBalance: 100,
          blockchainDigest: 'D-EARN',
        },
      },
    ]);
  });

  it('when the sync path and the indexer confirm concurrently, only the winner queues a webhook', async () => {
    const tx = await acceptEarn('e');

    const results = await Promise.all([
      confirmEarn(tx.id, 'D-SYNC'),
      db.transaction((t) => confirmEarn(tx.id, 'D-IDX', t)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
    expect(await confirmEarn(tx.id, 'D-LATE')).toBeNull();
    expect(await deliveries()).toHaveLength(1);
  });

  it('a confirm whose surrounding transaction rolls back (indexer crash mid-page) queues nothing', async () => {
    const tx = await acceptEarn('e');

    await expect(
      db.transaction(async (t) => {
        await confirmEarn(tx.id, 'D-PAGE', t);
        throw new Error('crash mid-page');
      }),
    ).rejects.toThrow('crash mid-page');

    expect(await deliveries()).toEqual([]);
    expect((await getLoyaltyTransaction(db, tx.id))?.status).toBe('PENDING');
    await confirmEarn(tx.id, 'D-PAGE');
    expect(await deliveries()).toHaveLength(1);
  });

  it('a failed earn queues no confirmation', async () => {
    const tx = await acceptEarn('e');
    await repo.failEarnOnChain({
      loyaltyTransactionId: tx.id,
      organizationEndUserId: memberId,
      reservedPointsAmount: 10_000,
    });
    expect(await deliveries()).toEqual([]);
  });

  it('a confirmed POS redemption queues exactly one credits.redemption.confirmed', async () => {
    await confirmedEarn(100);
    const ownership = await getOwnership(db, memberId);
    await repo.setSuiCreditAccountId(ownership.id, '0xacc');
    await db.delete(schema.webhookDeliveries);
    const { transaction } = await repo.reservePosRedemption({
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 30,
      idempotencyKey: 'pos',
    });

    const confirm = () =>
      repo.confirmPosRedemptionOnChain({
        loyaltyTransactionId: transaction.id,
        organizationEndUserId: memberId,
        pointsAmount: 30,
        digest: 'D-POS',
        sender: '0xbeneficiary',
      });
    await confirm();
    await expect(confirm()).resolves.toBeNull();

    expect(await deliveries()).toMatchObject([
      {
        eventType: 'credits.redemption.confirmed',
        payload: {
          transactionId: transaction.id,
          organizationEndUserId: memberId,
          pointsAmount: 30,
          newBalance: 70,
          blockchainDigest: 'D-POS',
        },
      },
    ]);
  });
});
