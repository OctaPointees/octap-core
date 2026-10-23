import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  OperationPayloadConflictError,
  OperationsRepository,
  acceptCommand,
  hashPayload,
} from '../../../src/infra/db/repositories/operations.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new OperationsRepository(db);

let orgId: string;

beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
});

afterAll(async () => {
  await client.end();
});

async function insertOperation(values: Partial<typeof schema.operations.$inferInsert> & { idempotencyKey: string }) {
  const [row] = await db
    .insert(schema.operations)
    .values({ tenantId: orgId, commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'PENDING', ...values })
    .returning();
  return row;
}

const statusOf = async (id: string) => (await db.select().from(schema.operations).where(eq(schema.operations.id, id)))[0];

describe('acceptCommand (live)', () => {
  const accept = (payload: Record<string, unknown>) =>
    db.transaction((tx) => acceptCommand(tx, { tenantId: orgId, idempotencyKey: 'k1', commandType: 'X', payload }));

  it('inserts once, replays an identical payload, and conflicts on a different one', async () => {
    const first = await accept({ a: 1, b: 2 });
    const replay = await accept({ b: 2, a: 1 });

    expect(first.isNew).toBe(true);
    expect(replay).toMatchObject({ isNew: false, operation: { id: first.operation.id } });
    await expect(accept({ a: 1, b: 3 })).rejects.toThrow(OperationPayloadConflictError);
  });

  it('adopts the hash of a row accepted before payload hashes existed', async () => {
    const legacy = await insertOperation({ idempotencyKey: 'k1', commandType: 'X', payloadHash: null });

    const result = await accept({ amount: 10 });

    expect(result).toMatchObject({ isNew: false, operation: { id: legacy.id, payloadHash: hashPayload({ amount: 10 }) } });
    expect((await statusOf(legacy.id)).payloadHash).toBe(hashPayload({ amount: 10 }));
  });
});

describe('OperationsRepository', () => {
  it('claimNextPending claims oldest-first, filters by command type, respects the limit, and flips to PROCESSING', async () => {
    const a = await insertOperation({ idempotencyKey: 'a', createdAt: new Date(Date.now() - 3000) });
    const b = await insertOperation({ idempotencyKey: 'b', createdAt: new Date(Date.now() - 2000) });
    await insertOperation({ idempotencyKey: 'c', createdAt: new Date(Date.now() - 1000) });
    await insertOperation({ idempotencyKey: 'other', commandType: 'CREDIT_POS_REDEEM_RESERVE' });
    await insertOperation({ idempotencyKey: 'done', status: 'SUBMITTED' });

    const claimed = await repo.claimNextPending(['CREDIT_EARN_CHAIN_SUBMIT'], 2);

    expect(claimed.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(claimed.every((o) => o.status === 'PROCESSING')).toBe(true);
    expect((await repo.claimNextPending(['CREDIT_EARN_CHAIN_SUBMIT'])).map((o) => o.idempotencyKey)).toEqual(['c']);
  });

  it('two workers racing never claim the same row', async () => {
    for (let i = 0; i < 6; i++) {
      await insertOperation({ idempotencyKey: `op-${i}` });
    }

    const [first, second] = await Promise.all([
      repo.claimNextPending(['CREDIT_EARN_CHAIN_SUBMIT'], 6),
      repo.claimNextPending(['CREDIT_EARN_CHAIN_SUBMIT'], 6),
    ]);

    const ids = [...first, ...second].map((o) => o.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('markSubmitted and markFailed record the outcome', async () => {
    const a = await insertOperation({ idempotencyKey: 'a', status: 'PROCESSING' });
    const b = await insertOperation({ idempotencyKey: 'b', status: 'PROCESSING' });

    await repo.markSubmitted(a.id, 'DIGEST');
    await repo.markFailed(b.id, 'EAbort');

    expect(await statusOf(a.id)).toMatchObject({ status: 'SUBMITTED', suiTxDigest: 'DIGEST' });
    expect(await statusOf(b.id)).toMatchObject({ status: 'FAILED', errorMessage: 'EAbort' });
  });

  it('markUnknown only moves a PROCESSING row, keeping the digest when one is known', async () => {
    const processing = await insertOperation({ idempotencyKey: 'p', status: 'PROCESSING' });
    const noDigest = await insertOperation({ idempotencyKey: 'n', status: 'PROCESSING' });
    const settled = await insertOperation({ idempotencyKey: 's', status: 'SUBMITTED', suiTxDigest: 'D-INDEXER' });

    expect(await repo.markUnknown(processing.id, 'PG down after landing', 'D-1')).toBe(true);
    expect(await repo.markUnknown(noDigest.id, 'outcome unknown')).toBe(true);
    expect(await repo.markUnknown(settled.id, 'late', 'D-2')).toBe(false);

    expect(await statusOf(processing.id)).toMatchObject({ status: 'UNKNOWN', errorMessage: 'PG down after landing', suiTxDigest: 'D-1' });
    expect(await statusOf(noDigest.id)).toMatchObject({ status: 'UNKNOWN', suiTxDigest: null });
    expect(await statusOf(settled.id)).toMatchObject({ status: 'SUBMITTED', suiTxDigest: 'D-INDEXER' });
  });

  it('markSubmittedFromChain settles any unresolved state but never a terminal one', async () => {
    const rows = await Promise.all(
      (['PENDING', 'PROCESSING', 'UNKNOWN', 'FAILED', 'SUBMITTED'] as const).map((status) => insertOperation({ idempotencyKey: status, status })),
    );

    for (const row of rows) {
      await repo.markSubmittedFromChain({ tenantId: orgId, idempotencyKey: row.idempotencyKey, suiTxDigest: 'D-CHAIN' });
    }

    const after = await Promise.all(rows.map((r) => statusOf(r.id)));
    expect(after.map((r) => [r.idempotencyKey, r.status])).toEqual([
      ['PENDING', 'SUBMITTED'],
      ['PROCESSING', 'SUBMITTED'],
      ['UNKNOWN', 'SUBMITTED'],
      ['FAILED', 'FAILED'],
      ['SUBMITTED', 'SUBMITTED'],
    ]);
  });

  it('markSubmittedFromChain is scoped to the tenant', async () => {
    const other = await seedOrganization(db);
    const row = await insertOperation({ idempotencyKey: 'k', status: 'UNKNOWN' });

    await repo.markSubmittedFromChain({ tenantId: other.id, idempotencyKey: 'k', suiTxDigest: 'D' });

    expect((await statusOf(row.id)).status).toBe('UNKNOWN');
  });

  it('recoverStaleProcessing flips only its own command type’s rows older than the threshold', async () => {
    const stale = await insertOperation({ idempotencyKey: 'stale', status: 'PROCESSING' });
    const fresh = await insertOperation({ idempotencyKey: 'fresh', status: 'PROCESSING' });
    const otherType = await insertOperation({ idempotencyKey: 'other', status: 'PROCESSING', commandType: 'SOMETHING_ELSE' });
    const pending = await insertOperation({ idempotencyKey: 'pending', status: 'PENDING' });
    await db
      .update(schema.operations)
      .set({ updatedAt: sql`now() - interval '10 minutes'` })
      .where(sql`${schema.operations.id} in (${stale.id}, ${otherType.id}, ${pending.id})`);

    const recovered = await repo.recoverStaleProcessing(['CREDIT_EARN_CHAIN_SUBMIT'], 5 * 60 * 1000);

    expect(recovered.map((o) => o.id)).toEqual([stale.id]);
    expect((await statusOf(stale.id)).status).toBe('UNKNOWN');
    expect((await statusOf(fresh.id)).status).toBe('PROCESSING');
    expect((await statusOf(otherType.id)).status).toBe('PROCESSING');
    expect((await statusOf(pending.id)).status).toBe('PENDING');
  });
});
