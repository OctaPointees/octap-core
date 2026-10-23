import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_ACCOUNT_STREAM, IndexerCursorMovedError, IndexerRepository } from '../../../src/infra/db/repositories/indexer.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new IndexerRepository(db);

beforeEach(async () => {
  await resetDb(client);
});

afterAll(async () => {
  await client.end();
});

describe('IndexerRepository', () => {
  it('initCursor creates the row once; concurrent bootstraps both land on the winner', async () => {
    const [a, b] = await Promise.all([
      repo.initCursor(CREDIT_ACCOUNT_STREAM, 'HEAD-A', '10'),
      repo.initCursor(CREDIT_ACCOUNT_STREAM, 'HEAD-B', '11'),
    ]);

    expect(a.id).toBe(b.id);
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: a.cursor, lastCheckpoint: a.lastCheckpoint });
    expect(await repo.getCursor('unknown-stream')).toBeUndefined();
  });

  it('commitPage commits the page’s writes and the cursor advance together', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');

    const result = await repo.commitPage(CREDIT_ACCOUNT_STREAM, { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: '150' }, async (tx) => {
      await tx.insert(schema.organizations).values({ slug: 'written-in-page', name: 'x' });
      return 'page-result';
    });

    expect(result).toBe('page-result');
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '150' });
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
  });

  it('a page with no checkpoint keeps the previous one', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');
    await repo.commitPage(CREDIT_ACCOUNT_STREAM, { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: null }, async () => {});
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '100' });
  });

  it('a failing page rolls back its writes and leaves the cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');

    await expect(
      repo.commitPage(CREDIT_ACCOUNT_STREAM, { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: '150' }, async (tx) => {
        await seedOrganization(tx);
        throw new Error('process killed');
      }),
    ).rejects.toThrow('process killed');

    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C0', lastCheckpoint: '100' });
    expect(await db.select().from(schema.organizations)).toEqual([]);
  });

  it('loses (and rolls back) when another instance already moved the cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C1', '100');

    await expect(
      repo.commitPage(CREDIT_ACCOUNT_STREAM, { expectedCursor: 'C0', nextCursor: 'C2', lastCheckpoint: null }, async (tx) => {
        await seedOrganization(tx);
      }),
    ).rejects.toThrow(IndexerCursorMovedError);
    expect(await db.select().from(schema.organizations)).toEqual([]);
  });

  it('advances from a null (read-from-genesis) cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, null, null);
    await repo.commitPage(CREDIT_ACCOUNT_STREAM, { expectedCursor: null, nextCursor: 'C1', lastCheckpoint: '1' }, async () => {});
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '1' });
  });
});
