import { describe, expect, it, vi } from 'vitest';
import type { CreditAccountEvent, CreditAccountEventPage } from '@octap/chain';
import { CheckpointIndexerProcessor } from '#domain/indexer/checkpoint-indexer.processor.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { IndexerRepository } from '#infra/db/repositories/indexer.repository.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { stub } from '../../../helpers/stub.js';
import { b64, buildLoyaltyTransaction, earnedEvent } from '../../../helpers/fixtures.js';

type CursorRow = { streamName: string; cursor: string | null; lastCheckpoint: string | null };
type FakeTx = { writes: string[] };

/**
 * In-memory stand-in for IndexerRepository with commitPage's real contract: `work`'s writes and the
 * cursor advance become visible together, or (if `work` throws) neither does.
 */
function fakeIndexerStore(initial: CursorRow | undefined) {
  const store = { row: initial, committedWrites: [] as string[] };
  const repo = {
    getCursor: async () => store.row,
    initCursor: async (streamName: string, cursor: string | null, lastCheckpoint: string | null) => {
      store.row ??= { streamName, cursor, lastCheckpoint };
      return store.row;
    },
    commitPage: async (
      _streamName: string,
      page: { expectedCursor: string | null; nextCursor: string; lastCheckpoint: string | null },
      work: (tx: FakeTx) => Promise<unknown>,
    ) => {
      expect(page.expectedCursor).toBe(store.row!.cursor);
      const tx: FakeTx = { writes: [] };
      const result = await work(tx);
      store.committedWrites.push(...tx.writes);
      store.row = {
        ...store.row!,
        cursor: page.nextCursor,
        lastCheckpoint: page.lastCheckpoint ?? store.row!.lastCheckpoint,
      };
      return result;
    },
  };
  return Object.assign(store, { repo });
}

const pendingEarnRow = (overrides: Parameters<typeof buildLoyaltyTransaction>[0] = {}) =>
  buildLoyaltyTransaction({
    id: 'ltx-earn-1',
    status: 'PENDING',
    pointsAmount: 10000,
    idempotencyKey: 'idem-earn-1',
    ...overrides,
  });

const page = (
  events: CreditAccountEvent[],
  overrides: Partial<CreditAccountEventPage> = {},
): CreditAccountEventPage => ({
  events,
  hasNextPage: false,
  startCursor: 'C1',
  endCursor: 'C2',
  ...overrides,
});

function processor(
  indexerRepo: unknown,
  creditsRepo: { [K in keyof CreditsRepository]?: unknown } = {},
  operationsRepo: { [K in keyof OperationsRepository]?: unknown } = {},
  sui: { [K in keyof SuiTransactionBuilderClient]?: unknown } = {},
  rewardsRepo: { [K in keyof RewardsRepository]?: unknown } = {},
) {
  return new CheckpointIndexerProcessor(
    indexerRepo as IndexerRepository,
    stub<CreditsRepository>(creditsRepo),
    stub<OperationsRepository>(operationsRepo),
    stub<SuiTransactionBuilderClient>(sui),
    stub<RewardsRepository>(rewardsRepo),
  );
}

const tx = { writes: [] } as unknown as DrizzleDb;
const ownedAccount = async () => ({ organizationEndUserId: 'user-1' });
const redeemedEvent = (reference: unknown, overrides: Partial<CreditAccountEvent> = {}): CreditAccountEvent => ({
  name: 'CreditRedeemed',
  sender: '0xbeneficiary',
  json: { account_id: '0xacc1', amount: '50', reference },
  checkpoint: '700',
  transactionDigest: 'DIGEST-REDEEM',
  eventIndex: 0,
  ...overrides,
});
const LOYALTY_ID = '0b3c1f9e-6a55-4d0b-9a63-2f1d7d1e8c11';
const pendingRedeemRow = (overrides: Parameters<typeof buildLoyaltyTransaction>[0] = {}) =>
  buildLoyaltyTransaction({
    id: LOYALTY_ID,
    transactionType: 'REDEEM',
    status: 'PENDING',
    pointsAmount: 50,
    idempotencyKey: 'idem-pos-1',
    ...overrides,
  });

describe('CheckpointIndexerProcessor.processNextPage', () => {
  it('first run starts from the stream head, not genesis', async () => {
    const store = fakeIndexerStore(undefined);
    const listCreditAccountEvents = vi.fn(async () =>
      page([earnedEvent({ checkpoint: '900' })], { hasNextPage: true, startCursor: 'HEAD', endCursor: 'HEAD' }),
    );

    expect(await processor(store.repo, {}, {}, { listCreditAccountEvents }).processNextPage()).toBe(true);

    expect(listCreditAccountEvents).toHaveBeenCalledWith({ order: 'descending', limit: 1 });
    expect(store.row).toEqual({ streamName: 'octap::credit_account', cursor: 'HEAD', lastCheckpoint: '900' });
  });

  it('first run on an empty stream starts from a null cursor', async () => {
    const store = fakeIndexerStore(undefined);

    await processor(
      store.repo,
      {},
      {},
      { listCreditAccountEvents: async () => page([], { startCursor: null, endCursor: null }) },
    ).processNextPage();

    expect(store.row).toEqual({ streamName: 'octap::credit_account', cursor: null, lastCheckpoint: null });
  });

  it('a PENDING earn (operation UNKNOWN) is confirmed by the indexer alone', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: '400' });
    const confirmEarnOnChain = vi.fn(async (_params: unknown, t: FakeTx) => {
      t.writes.push('confirm');
      return { id: 'btx-1' };
    });
    const markSubmittedFromChain = vi.fn(async (_params: unknown, t: FakeTx) => {
      t.writes.push('operation');
    });
    const listCreditAccountEvents = vi.fn(async () =>
      page([
        {
          name: 'CreditAccountOpened',
          sender: '0xissuer',
          json: { account_id: '0xacc1' },
          checkpoint: '499',
          transactionDigest: 'D0',
          eventIndex: 0,
        },
        earnedEvent(),
      ]),
    );

    const more = await processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: async (accountId: string) =>
          accountId === '0xacc1' ? { organizationEndUserId: 'user-1' } : undefined,
        findTransactionByMemberAndIdempotency: async (memberId: string, key: string) =>
          memberId === 'user-1' && key === 'idem-earn-1' ? pendingEarnRow() : undefined,
        confirmEarnOnChain,
      },
      { markSubmittedFromChain },
      { listCreditAccountEvents },
    ).processNextPage();

    expect(more).toBe(false);
    expect(listCreditAccountEvents).toHaveBeenCalledWith({ after: 'C0', limit: 50 });
    expect(confirmEarnOnChain).toHaveBeenCalledWith(
      {
        loyaltyTransactionId: 'ltx-earn-1',
        organizationEndUserId: 'user-1',
        confirmedPointsAmount: 100,
        bucketExpiresAtMs: null,
        digest: 'DIGEST-EARN',
        sender: '0xissuer',
      },
      expect.anything(),
    );
    expect(markSubmittedFromChain).toHaveBeenCalledWith(
      { tenantId: 'org-1', idempotencyKey: 'idem-earn-1', suiTxDigest: 'DIGEST-EARN' },
      expect.anything(),
    );
    // Business writes and cursor advance landed in the same commit.
    expect(store.committedWrites).toEqual(['confirm', 'operation']);
    expect(store.row).toMatchObject({ cursor: 'C2', lastCheckpoint: '500' });
  });

  it('rows the synchronous path already resolved are skipped (their operation settled), including a digest unique-violation', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: null });
    const confirmEarnOnChain = vi.fn(async () => {
      throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    });
    const markSubmittedFromChain = vi.fn(async () => {});

    await processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findTransactionByMemberAndIdempotency: async (_memberId: string, key: string) =>
          key === 'already-confirmed'
            ? pendingEarnRow({ status: 'CONFIRMED' })
            : pendingEarnRow({ idempotencyKey: key }),
        confirmEarnOnChain,
      },
      { markSubmittedFromChain },
      {
        listCreditAccountEvents: async () =>
          page([
            earnedEvent({ json: { account_id: '0xacc1', amount: '100', operation_key: b64('already-confirmed') } }),
            earnedEvent({ json: { account_id: '0xacc1', amount: '100', operation_key: b64('digest-recorded') } }),
          ]),
      },
    ).processNextPage();

    expect(confirmEarnOnChain).toHaveBeenCalledOnce();
    // The CONFIRMED row's operation may have been left UNKNOWN by a failed markSubmitted; the event settles it.
    expect(markSubmittedFromChain).toHaveBeenCalledOnce();
    expect(markSubmittedFromChain).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-earn-1' }),
      expect.anything(),
    );
    expect(store.row?.cursor).toBe('C2');
  });

  it('a crash mid-page commits nothing, and the restart resumes from the last committed cursor', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: '400' });
    let crashOnSecond = true;
    const afterSeen: unknown[] = [];
    const indexer = processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findTransactionByMemberAndIdempotency: async (_memberId: string, key: string) =>
          pendingEarnRow({ idempotencyKey: key }),
        confirmEarnOnChain: async (params: { digest: string }, t: FakeTx) => {
          if (crashOnSecond && params.digest === 'D2') {
            throw new Error('process killed');
          }
          t.writes.push(params.digest);
          return { id: params.digest };
        },
      },
      { markSubmittedFromChain: async () => {} },
      {
        listCreditAccountEvents: async ({ after }: { after: string }) => {
          afterSeen.push(after);
          return page([
            earnedEvent({
              transactionDigest: 'D1',
              json: { account_id: '0xacc1', amount: '1', operation_key: b64('k1') },
            }),
            earnedEvent({
              transactionDigest: 'D2',
              json: { account_id: '0xacc1', amount: '2', operation_key: b64('k2') },
            }),
          ]);
        },
      },
    );

    await expect(indexer.processNextPage()).rejects.toThrow(/process killed/);
    expect(store.row?.cursor).toBe('C0');
    expect(store.committedWrites).toEqual([]);

    // "Restart": same page again from the committed cursor; each event is applied exactly once overall.
    crashOnSecond = false;
    await indexer.processNextPage();
    expect(afterSeen).toEqual(['C0', 'C0']);
    expect(store.committedWrites).toEqual(['D1', 'D2']);
    expect(store.row?.cursor).toBe('C2');
  });

  it('a PENDING POS redemption is confirmed from CreditRedeemed by its reference', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: null });
    const confirmPosRedemptionOnChain = vi.fn(async () => ({ id: 'btx-2' }));
    const markSubmittedFromChain = vi.fn(async () => {});

    await processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        getLoyaltyTransactionById: async (id: string) => (id === LOYALTY_ID ? pendingRedeemRow() : undefined),
        confirmPosRedemptionOnChain,
      },
      { markSubmittedFromChain },
      { listCreditAccountEvents: async () => page([redeemedEvent(b64(LOYALTY_ID))], { endCursor: 'C1' }) },
    ).processNextPage();

    expect(confirmPosRedemptionOnChain).toHaveBeenCalledWith(
      {
        loyaltyTransactionId: LOYALTY_ID,
        organizationEndUserId: 'user-1',
        pointsAmount: 50,
        digest: 'DIGEST-REDEEM',
        sender: '0xbeneficiary',
      },
      expect.anything(),
    );
    expect(markSubmittedFromChain).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-pos-1' }),
      expect.anything(),
    );
    expect(store.row?.lastCheckpoint).toBe('700');
  });

  it('settles a customer-signed voucher claim from its ownership reference', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: null });
    const findVoucherClaimTransaction = vi.fn(async () => pendingRedeemRow());
    const confirmPosRedemptionOnChain = vi.fn(async () => ({ id: 'receipt' }));
    await processor(
      store.repo,
      { findCreditOwnershipBySuiAccountId: ownedAccount, findVoucherClaimTransaction, confirmPosRedemptionOnChain },
      { markSubmittedFromChain: async () => {} },
      { listCreditAccountEvents: async () => page([redeemedEvent(b64(`voucher-claim-${LOYALTY_ID}`))]) },
    ).processNextPage();
    expect(findVoucherClaimTransaction).toHaveBeenCalledWith(LOYALTY_ID);
    expect(confirmPosRedemptionOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ loyaltyTransactionId: LOYALTY_ID, pointsAmount: 50 }),
      expect.anything(),
    );
  });

  it('a terminal empty page leaves the cursor where it was', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C5', lastCheckpoint: '800' });
    store.repo.commitPage = async () => expect.fail('nothing to commit');

    const more = await processor(
      store.repo,
      {},
      {},
      {
        listCreditAccountEvents: async () => page([], { startCursor: null, endCursor: null }),
      },
    ).processNextPage();

    expect(more).toBe(false);
    expect(store.row?.cursor).toBe('C5');
  });

  it('a scan-limited empty page still advances the cursor and keeps the last checkpoint', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C5', lastCheckpoint: '800' });

    const more = await processor(
      store.repo,
      {},
      {},
      {
        listCreditAccountEvents: async () => page([], { hasNextPage: true, endCursor: 'C6' }),
      },
    ).processNextPage();

    expect(more).toBe(true);
    expect(store.row).toMatchObject({ cursor: 'C6', lastCheckpoint: '800' });
  });

  it('CreditExpired runs the member expiry sweep inside the page transaction', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: null });
    const expireDueBucketsForMember = vi.fn(async (_member: unknown, t: FakeTx) => {
      t.writes.push('expire');
      return 2500;
    });

    await processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findMemberOrganizationId: async () => 'org-1',
        expireDueBucketsForMember,
      },
      {},
      {
        listCreditAccountEvents: async () =>
          page(
            [
              {
                name: 'CreditExpired',
                sender: '0xbeneficiary',
                json: { account_id: '0xacc1', amount: '2500' },
                checkpoint: '900',
                transactionDigest: 'D-EXP',
                eventIndex: 0,
              },
            ],
            { endCursor: 'C1' },
          ),
      },
    ).processNextPage();

    expect(expireDueBucketsForMember).toHaveBeenCalledWith(
      { organizationId: 'org-1', organizationEndUserId: 'user-1' },
      expect.anything(),
    );
    expect(store.committedWrites).toEqual(['expire']);
  });

  it('an already-CONFIRMED earn gets its bucket backfilled, PENDING earns get one on confirm', async () => {
    const store = fakeIndexerStore({ streamName: 'octap::credit_account', cursor: 'C0', lastCheckpoint: null });
    const ensureEarnBucket = vi.fn(async () => {});
    const confirmEarnOnChain = vi.fn(async () => ({ id: 'btx-1' }));

    await processor(
      store.repo,
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findTransactionByMemberAndIdempotency: async (_memberId: string, key: string) =>
          key === 'old-earn'
            ? pendingEarnRow({ id: 'ltx-old', status: 'CONFIRMED', idempotencyKey: key })
            : pendingEarnRow(),
        ensureEarnBucket,
        confirmEarnOnChain,
      },
      { markSubmittedFromChain: async () => {} },
      {
        listCreditAccountEvents: async () =>
          page([
            earnedEvent({
              json: {
                account_id: '0xacc1',
                amount: '2500',
                operation_key: b64('old-earn'),
                bucket_expires_at_ms: '1794560971900',
              },
            }),
            earnedEvent({
              json: {
                account_id: '0xacc1',
                amount: '100',
                operation_key: b64('idem-earn-1'),
                bucket_expires_at_ms: '1794560999999',
              },
            }),
          ]),
      },
    ).processNextPage();

    expect(ensureEarnBucket).toHaveBeenCalledWith(
      { organizationEndUserId: 'user-1', earnTransactionId: 'ltx-old', amount: 2500, expiresAtMs: 1794560971900 },
      expect.anything(),
    );
    expect(confirmEarnOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ bucketExpiresAtMs: 1794560999999 }),
      expect.anything(),
    );
  });
});

describe('CheckpointIndexerProcessor.applyEvent', () => {
  it.each(['CreditAccountOpened', 'SomethingElse'])('ignores %s events', async (name) => {
    expect(await processor({}).applyEvent(earnedEvent({ name }), tx)).toBe('skipped');
  });

  it.each([
    ['no account_id', { amount: '1' }],
    ['a non-numeric amount', { account_id: '0xacc1', amount: 'lots' }],
    ['a null payload', null],
  ])('skips an event with %s', async (_label, json) => {
    const indexer = processor(
      {},
      { findCreditOwnershipBySuiAccountId: () => expect.fail('nothing usable to look up') },
    );
    expect(await indexer.applyEvent(earnedEvent({ json: json as Record<string, unknown> | null }), tx)).toBe('skipped');
  });

  it('skips an account this deployment did not open', async () => {
    const indexer = processor({}, { findCreditOwnershipBySuiAccountId: async () => undefined });
    expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
  });

  it('rethrows an error that is not a unique violation', async () => {
    const indexer = processor(
      {},
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findTransactionByMemberAndIdempotency: async () => {
          throw new Error('connection reset');
        },
      },
    );
    await expect(indexer.applyEvent(earnedEvent(), tx)).rejects.toThrow('connection reset');
  });

  it('treats a raw postgres-js unique violation as already applied', async () => {
    const indexer = processor(
      {},
      {
        findCreditOwnershipBySuiAccountId: ownedAccount,
        findTransactionByMemberAndIdempotency: async () => {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        },
      },
    );
    expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
  });

  describe('CreditEarned', () => {
    it('decodes a JSON-RPC style number-array operation key too', async () => {
      const findTransactionByMemberAndIdempotency = vi.fn(async () => undefined);
      const indexer = processor(
        {},
        { findCreditOwnershipBySuiAccountId: ownedAccount, findTransactionByMemberAndIdempotency },
      );

      await indexer.applyEvent(
        earnedEvent({
          json: { account_id: '0xacc1', amount: '1', operation_key: Array.from(Buffer.from('idem-arr')) },
        }),
        tx,
      );

      expect(findTransactionByMemberAndIdempotency).toHaveBeenCalledWith('user-1', 'idem-arr');
    });

    it.each([
      ['a missing operation key', undefined],
      ['an operation key of the wrong shape', { not: 'bytes' }],
      ['an array containing non-numbers', ['a', 'b']],
    ])('skips %s', async (_label, operationKey) => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findTransactionByMemberAndIdempotency: () => expect.fail('no key to look up'),
        },
      );
      expect(
        await indexer.applyEvent(
          earnedEvent({ json: { account_id: '0xacc1', amount: '1', operation_key: operationKey } }),
          tx,
        ),
      ).toBe('skipped');
    });

    it('skips when no loyalty transaction (or a non-EARN one) has that key', async () => {
      for (const row of [undefined, pendingEarnRow({ transactionType: 'REDEEM' })]) {
        const indexer = processor(
          {},
          {
            findCreditOwnershipBySuiAccountId: ownedAccount,
            findTransactionByMemberAndIdempotency: async () => row,
            confirmEarnOnChain: () => expect.fail('nothing to confirm'),
          },
        );
        expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
      }
    });

    it('settles a CONFIRMED earn without a bucket expiry without touching buckets', async () => {
      const markSubmittedFromChain = vi.fn(async () => {});
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findTransactionByMemberAndIdempotency: async () => pendingEarnRow({ status: 'CONFIRMED' }),
          ensureEarnBucket: () => expect.fail('no expiry on the event, so no bucket'),
        },
        { markSubmittedFromChain },
      );

      expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
      expect(markSubmittedFromChain).toHaveBeenCalledOnce();
    });

    it.each(['FAILED', 'REVERSED'] as const)('skips a %s earn', async (status) => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findTransactionByMemberAndIdempotency: async () => pendingEarnRow({ status }),
          confirmEarnOnChain: () => expect.fail('a terminal row is never re-confirmed'),
        },
      );
      expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
    });

    it('skips without settling when confirm finds the row already resolved', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findTransactionByMemberAndIdempotency: async () => pendingEarnRow(),
          confirmEarnOnChain: async () => null,
        },
        { markSubmittedFromChain: () => expect.fail('the winner settles it') },
      );
      expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('skipped');
    });

    it('reports confirmed for a confirmed PENDING earn', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findTransactionByMemberAndIdempotency: async () => pendingEarnRow(),
          confirmEarnOnChain: async () => ({ id: 'btx' }),
        },
        { markSubmittedFromChain: async () => {} },
      );
      expect(await indexer.applyEvent(earnedEvent(), tx)).toBe('confirmed');
    });
  });

  describe('CreditRedeemed', () => {
    it.each([
      ['a missing reference', undefined],
      ['a reference that is not a uuid', b64('not-a-uuid')],
    ])('skips %s', async (_label, reference) => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          getLoyaltyTransactionById: () => expect.fail('nothing to look up'),
        },
      );
      expect(await indexer.applyEvent(redeemedEvent(reference), tx)).toBe('skipped');
    });

    it.each([
      ['no such transaction', undefined],
      ['a non-REDEEM transaction', pendingRedeemRow({ transactionType: 'EARN' })],
      ['another member’s transaction', pendingRedeemRow({ organizationEndUserId: 'user-2' })],
      ['a FAILED transaction', pendingRedeemRow({ status: 'FAILED' })],
      ['an amount mismatch', pendingRedeemRow({ pointsAmount: 49 })],
    ])('skips %s', async (_label, row) => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          getLoyaltyTransactionById: async () => row,
          confirmPosRedemptionOnChain: () => expect.fail('must not confirm'),
        },
      );
      expect(await indexer.applyEvent(redeemedEvent(b64(LOYALTY_ID)), tx)).toBe('skipped');
    });

    it('settles the operation of an already-CONFIRMED redemption', async () => {
      const markSubmittedFromChain = vi.fn(async () => {});
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          getLoyaltyTransactionById: async () => pendingRedeemRow({ status: 'CONFIRMED' }),
        },
        { markSubmittedFromChain },
      );

      expect(await indexer.applyEvent(redeemedEvent(b64(LOYALTY_ID)), tx)).toBe('skipped');
      expect(markSubmittedFromChain).toHaveBeenCalledWith(
        { tenantId: 'org-1', idempotencyKey: 'idem-pos-1', suiTxDigest: 'DIGEST-REDEEM' },
        tx,
      );
    });

    it('skips without settling when confirm finds the row already resolved', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          getLoyaltyTransactionById: async () => pendingRedeemRow(),
          confirmPosRedemptionOnChain: async () => null,
        },
        { markSubmittedFromChain: () => expect.fail('the winner settles it') },
      );
      expect(await indexer.applyEvent(redeemedEvent(b64(LOYALTY_ID)), tx)).toBe('skipped');
    });

    it('reports confirmed for a confirmed PENDING redemption', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          getLoyaltyTransactionById: async () => pendingRedeemRow(),
          confirmPosRedemptionOnChain: async () => ({ id: 'btx' }),
        },
        { markSubmittedFromChain: async () => {} },
      );
      expect(await indexer.applyEvent(redeemedEvent(b64(LOYALTY_ID)), tx)).toBe('confirmed');
    });
  });

  describe('CreditExpired', () => {
    const expired: CreditAccountEvent = {
      name: 'CreditExpired',
      sender: '0xb',
      json: { account_id: '0xacc1', amount: '10' },
      checkpoint: '1',
      transactionDigest: 'D',
      eventIndex: 0,
    };

    it('skips a member whose organization can no longer be found', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findMemberOrganizationId: async () => null,
          expireDueBucketsForMember: () => expect.fail('no member to sweep'),
        },
      );
      expect(await indexer.applyEvent(expired, tx)).toBe('skipped');
    });

    it('a sweep that forfeits nothing (a read got there first) is a skip', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findMemberOrganizationId: async () => 'org-1',
          expireDueBucketsForMember: async () => 0,
        },
      );
      expect(await indexer.applyEvent(expired, tx)).toBe('skipped');
    });

    it('a sweep that forfeits points is a confirmation', async () => {
      const indexer = processor(
        {},
        {
          findCreditOwnershipBySuiAccountId: ownedAccount,
          findMemberOrganizationId: async () => 'org-1',
          expireDueBucketsForMember: async () => 10,
        },
      );
      expect(await indexer.applyEvent(expired, tx)).toBe('confirmed');
    });
  });
});

describe('CheckpointIndexerProcessor voucher events', () => {
  const event = (name: string, overrides: Record<string, unknown> = {}): CreditAccountEvent =>
    earnedEvent({
      name,
      transactionDigest: 'DIGEST-V',
      json: {
        account_id: '0xaccount',
        reference: b64('voucher-claim-11111111-1111-4111-8111-111111111111'),
        ...overrides,
      },
    });
  const voucherId = '11111111-1111-4111-8111-111111111111';
  const tx = {} as DrizzleDb;
  const creditsRepo = {
    findCreditOwnershipBySuiAccountId: async () => ({ organizationEndUserId: 'member-1' }),
  };
  const found = async () => ({ id: voucherId, organizationEndUserId: 'member-1' });

  it('a use follows the chain and settles the command behind it', async () => {
    const confirmVoucherUse = vi.fn(async () => ({ key: { tenantId: 'org-1', idempotencyKey: 'use-1' } }));
    const markSubmittedFromChain = vi.fn(async () => {});
    const outcome = await processor(
      {},
      creditsRepo,
      { markSubmittedFromChain },
      {},
      {
        findOwnershipWithVoucher: found,
        confirmVoucherUse,
      },
    ).applyEvent(event('VoucherUsed'), tx);
    expect(outcome).toBe('confirmed');
    expect(confirmVoucherUse).toHaveBeenCalledWith({ voucherOwnershipId: voucherId, digest: 'DIGEST-V' }, tx);
    expect(markSubmittedFromChain).toHaveBeenCalledWith(
      { tenantId: 'org-1', idempotencyKey: 'use-1', suiTxDigest: 'DIGEST-V' },
      tx,
    );
  });

  it('a use with no command behind it still applies', async () => {
    const markSubmittedFromChain = vi.fn();
    const outcome = await processor(
      {},
      creditsRepo,
      { markSubmittedFromChain },
      {},
      {
        findOwnershipWithVoucher: found,
        confirmVoucherUse: async () => ({ key: null }),
      },
    ).applyEvent(event('VoucherUsed'), tx);
    expect(outcome).toBe('confirmed');
    expect(markSubmittedFromChain).not.toHaveBeenCalled();
  });

  it('a grant confirms the reserved voucher', async () => {
    const confirmVoucherGrant = vi.fn(async () => ({ key: null }));
    const outcome = await processor(
      {},
      creditsRepo,
      {},
      {},
      {
        findOwnershipWithVoucher: found,
        confirmVoucherGrant,
      },
    ).applyEvent(event('VoucherGranted'), tx);
    expect(outcome).toBe('confirmed');
    expect(confirmVoucherGrant).toHaveBeenCalledWith({ voucherOwnershipId: voucherId, digest: 'DIGEST-V' }, tx);
  });

  it.each([
    ['an unrelated reference', event('VoucherUsed', { reference: b64('something-else') }), {}, {}],
    ['a malformed account id', event('VoucherUsed', { account_id: 7 }), {}, {}],
    [
      "another deployment's account",
      event('VoucherUsed'),
      { findCreditOwnershipBySuiAccountId: async () => undefined },
      {},
    ],
    ['an unknown voucher', event('VoucherUsed'), creditsRepo, { findOwnershipWithVoucher: async () => undefined }],
    [
      "another member's voucher",
      event('VoucherUsed'),
      creditsRepo,
      { findOwnershipWithVoucher: async () => ({ id: voucherId, organizationEndUserId: 'member-2' }) },
    ],
    [
      'a voucher already settled',
      event('VoucherUsed'),
      creditsRepo,
      { findOwnershipWithVoucher: found, confirmVoucherUse: async () => null },
    ],
  ])('skips %s', async (_, voucherEvent, credits, rewards) => {
    const outcome = await processor({}, credits, {}, {}, rewards).applyEvent(voucherEvent, tx);
    expect(outcome).toBe('skipped');
  });
});
