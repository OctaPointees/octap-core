import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDIT_ACCOUNT_STREAM,
  IndexerCursorMovedError,
  IndexerRepository,
} from '#infra/db/repositories/indexer.repository.js';
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
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({
      cursor: a.cursor,
      lastCheckpoint: a.lastCheckpoint,
    });
    expect(await repo.getCursor('unknown-stream')).toBeUndefined();
  });

  it('commitPage commits the page’s writes and the cursor advance together', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');

    const result = await repo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: '150' },
      async (tx) => {
        await tx.insert(schema.organizations).values({ slug: 'written-in-page', name: 'x' });
        return 'page-result';
      },
    );

    expect(result).toBe('page-result');
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '150' });
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
  });

  it('a page with no checkpoint keeps the previous one', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');
    await repo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: null },
      async () => {},
    );
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '100' });
  });

  it('a failing page rolls back its writes and leaves the cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');

    await expect(
      repo.commitPage(
        CREDIT_ACCOUNT_STREAM,
        { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: '150' },
        async (tx) => {
          await seedOrganization(tx);
          throw new Error('process killed');
        },
      ),
    ).rejects.toThrow('process killed');

    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C0', lastCheckpoint: '100' });
    expect(await db.select().from(schema.organizations)).toEqual([]);
  });

  it('loses (and rolls back) when another instance already moved the cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C1', '100');

    await expect(
      repo.commitPage(
        CREDIT_ACCOUNT_STREAM,
        { expectedCursor: 'C0', nextCursor: 'C2', lastCheckpoint: null },
        async (tx) => {
          await seedOrganization(tx);
        },
      ),
    ).rejects.toThrow(IndexerCursorMovedError);
    expect(await db.select().from(schema.organizations)).toEqual([]);
  });

  it('advances from a null (read-from-genesis) cursor', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, null, null);
    await repo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: null, nextCursor: 'C1', lastCheckpoint: '1' },
      async () => {},
    );
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', lastCheckpoint: '1' });
  });

  it('markCaughtUp only raises the mark, numerically, and only for the cursor it saw', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100');

    await repo.markCaughtUp(CREDIT_ACCOUNT_STREAM, 'C0', 9_000n);
    await repo.markCaughtUp(CREDIT_ACCOUNT_STREAM, 'C0', 10_000n);
    // As text, '9999' > '10000'; the mark must compare as a number.
    await repo.markCaughtUp(CREDIT_ACCOUNT_STREAM, 'C0', 9_999n);
    await repo.markCaughtUp(CREDIT_ACCOUNT_STREAM, 'C-other', 50_000n);

    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C0', caughtUpCheckpoint: '10000' });
  });

  it('commitPage raises the mark with the cursor, and never lowers it', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'C0', '100', 500n);

    await repo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: 'C0', nextCursor: 'C1', lastCheckpoint: '150', caughtUpCheckpoint: 400n },
      async () => {},
    );
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C1', caughtUpCheckpoint: '500' });

    await repo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: 'C1', nextCursor: 'C2', lastCheckpoint: '160', caughtUpCheckpoint: 900n },
      async () => {},
    );
    expect(await repo.getCursor(CREDIT_ACCOUNT_STREAM)).toMatchObject({ cursor: 'C2', caughtUpCheckpoint: '900' });
  });

  it('replaceCursor swaps the cursor in place, and loses to an instance that moved it first', async () => {
    await repo.initCursor(CREDIT_ACCOUNT_STREAM, 'RESUME_AT_HEAD', 'old');
    const before = await repo.getCursor(CREDIT_ACCOUNT_STREAM);

    await repo.replaceCursor(CREDIT_ACCOUNT_STREAM, {
      expectedCursor: 'RESUME_AT_HEAD',
      cursor: null,
      lastCheckpoint: null,
    });
    const after = await repo.getCursor(CREDIT_ACCOUNT_STREAM);
    expect(after).toMatchObject({ id: before!.id, cursor: null, lastCheckpoint: null });

    await expect(
      repo.replaceCursor(CREDIT_ACCOUNT_STREAM, { expectedCursor: 'RESUME_AT_HEAD', cursor: 'X' }),
    ).rejects.toThrow(IndexerCursorMovedError);
    expect((await repo.getCursor(CREDIT_ACCOUNT_STREAM))?.cursor).toBeNull();
  });
});
