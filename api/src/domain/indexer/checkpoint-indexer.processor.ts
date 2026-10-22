import { Injectable, Logger } from '@nestjs/common';
import type { CreditAccountEvent } from '@octap/chain';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import { OperationsRepository } from '../../infra/db/repositories/operations.repository.js';
import { CREDIT_ACCOUNT_STREAM, IndexerRepository } from '../../infra/db/repositories/indexer.repository.js';
import type { DrizzleDb } from '../../infra/db/postgres.provider.js';
import { SuiTransactionBuilderClient } from '../../infra/clients/sui/sui-transaction-builder.client.js';

const PAGE_SIZE = Number(process.env.INDEXER_PAGE_SIZE ?? 50);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EventOutcome = 'confirmed' | 'skipped';

/**
 * vector<u8> fields arrive base64-encoded over gRPC (confirmed live against testnet:
 * `operation_key: "ZGVtby1wb3MtMDAx"` is `demo-pos-001`); a number array is what JSON-RPC used to
 * return, accepted too so a transport swap doesn't silently skip every event.
 */
function decodeBytesField(value: unknown): string | null {
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64').toString('utf8');
  }
  if (Array.isArray(value) && value.every((b) => typeof b === 'number')) {
    return Buffer.from(value as number[]).toString('utf8');
  }
  return null;
}

/** postgres-js reports `code` directly; drizzle wraps it in a `DrizzleQueryError` whose `cause` carries it. */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505';
}

/**
 * Projects one page of `octap::credit_account` events onto PostgreSQL. Lifecycle (polling,
 * shutdown) stays in `checkpoint-indexer.worker.ts`.
 *
 * Only reconciles: a `CreditEarned`/`CreditRedeemed` whose loyalty transaction is still PENDING
 * (including one whose operation went UNKNOWN after a worker crash, OCT-43) is confirmed through
 * the same `confirmEarnOnChain`/`confirmPosRedemptionOnChain` the synchronous paths use. Anything
 * already resolved is skipped. Events never create loyalty transactions — an on-chain effect with
 * no PG command behind it is not something this projection invents a row for.
 *
 * Sui only emits events for transactions that executed successfully (an aborted transaction's
 * events are discarded with the rest of its effects), so an event here is already proof of a
 * successful effect; there is no failed-transaction case to filter out.
 */
@Injectable()
export class CheckpointIndexerProcessor {
  private readonly logger = new Logger(CheckpointIndexerProcessor.name);

  constructor(
    private readonly indexerRepo: IndexerRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly operationsRepo: OperationsRepository,
    private readonly sui: SuiTransactionBuilderClient,
  ) {}

  /** Processes at most one page; returns whether another page is available right away. */
  async processNextPage(): Promise<boolean> {
    const state = await this.indexerRepo.getCursor(CREDIT_ACCOUNT_STREAM);
    if (!state) {
      await this.bootstrap();
      return true;
    }

    const page = await this.sui.listCreditAccountEvents({ after: state.cursor, limit: PAGE_SIZE });
    if (!page.endCursor) {
      // Terminal page with nothing new: the stored cursor is still the right place to resume.
      return false;
    }

    const lastCheckpoint = [...page.events].reverse().find((e) => e.checkpoint !== null)?.checkpoint ?? null;
    const outcomes = await this.indexerRepo.commitPage(
      CREDIT_ACCOUNT_STREAM,
      { expectedCursor: state.cursor, nextCursor: page.endCursor, lastCheckpoint },
      async (tx) => {
        const results: EventOutcome[] = [];
        for (const event of page.events) {
          results.push(await this.applyEvent(event, tx));
        }
        return results;
      },
    );

    const confirmed = outcomes.filter((o) => o === 'confirmed').length;
    if (confirmed > 0) {
      this.logger.log(`confirmed ${confirmed} transaction(s) from ${page.events.length} event(s), checkpoint ${lastCheckpoint}`);
    }
    return page.hasNextPage;
  }

  /**
   * First run starts at the stream's current head, not its first event: this demo has no
   * historical backlog worth replaying, and anything before the head was already resolved (or
   * left UNKNOWN for a human) by the synchronous path. A deliberate choice — delete the cursor
   * row and set it to null by hand to replay from the beginning instead.
   */
  private async bootstrap(): Promise<void> {
    const head = await this.sui.listCreditAccountEvents({ order: 'descending', limit: 1 });
    const latest = head.events[0];
    await this.indexerRepo.initCursor(
      CREDIT_ACCOUNT_STREAM,
      latest ? head.startCursor : null,
      latest?.checkpoint ?? null,
    );
    this.logger.log(`initialized ${CREDIT_ACCOUNT_STREAM} cursor at checkpoint ${latest?.checkpoint ?? '(empty stream)'}`);
  }

  async applyEvent(event: CreditAccountEvent, tx: DrizzleDb): Promise<EventOutcome> {
    if (event.name !== 'CreditEarned' && event.name !== 'CreditRedeemed') {
      return 'skipped';
    }

    const accountId = event.json?.account_id;
    const amount = Number(event.json?.amount);
    if (typeof accountId !== 'string' || !Number.isSafeInteger(amount)) {
      this.logger.warn(`${event.name} ${event.transactionDigest}#${event.eventIndex} has no usable account_id/amount`);
      return 'skipped';
    }

    const ownership = await this.creditsRepo.findCreditOwnershipBySuiAccountId(accountId);
    if (!ownership) {
      // Not an account this deployment opened (another environment sharing the package).
      return 'skipped';
    }

    try {
      return event.name === 'CreditEarned'
        ? await this.applyEarned(event, tx, ownership.organizationEndUserId, amount)
        : await this.applyRedeemed(event, tx, ownership.organizationEndUserId, amount);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // `blockchain_transactions.digest` is unique: this digest is already recorded, so
        // whatever recorded it already applied the effect. Rolled back to the savepoint only.
        return 'skipped';
      }
      throw err;
    }
  }

  private async applyEarned(
    event: CreditAccountEvent,
    tx: DrizzleDb,
    organizationEndUserId: string,
    amount: number,
  ): Promise<EventOutcome> {
    const operationKey = decodeBytesField(event.json?.operation_key);
    if (!operationKey) {
      return 'skipped';
    }
    const loyaltyTx = await this.creditsRepo.findTransactionByMemberAndIdempotency(organizationEndUserId, operationKey);
    if (!loyaltyTx || loyaltyTx.transactionType !== 'EARN') {
      return 'skipped';
    }
    if (loyaltyTx.status === 'CONFIRMED') {
      await this.settleOperation(loyaltyTx, event, tx);
      return 'skipped';
    }
    if (loyaltyTx.status !== 'PENDING') {
      return 'skipped';
    }

    const confirmed = await this.creditsRepo.confirmEarnOnChain(
      {
        loyaltyTransactionId: loyaltyTx.id,
        organizationEndUserId,
        reservedPointsAmount: Number(loyaltyTx.pointsAmount),
        confirmedPointsAmount: amount,
        digest: event.transactionDigest,
        sender: event.sender,
      },
      tx,
    );
    if (!confirmed) {
      return 'skipped';
    }
    await this.operationsRepo.markSubmittedFromChain(
      { tenantId: loyaltyTx.organizationId, idempotencyKey: loyaltyTx.idempotencyKey, suiTxDigest: event.transactionDigest },
      tx,
    );
    return 'confirmed';
  }

  private async applyRedeemed(
    event: CreditAccountEvent,
    tx: DrizzleDb,
    organizationEndUserId: string,
    amount: number,
  ): Promise<EventOutcome> {
    // POS redemption passes the loyalty transaction id as `reference` (pos-redemption.service.ts).
    const loyaltyTransactionId = decodeBytesField(event.json?.reference);
    if (!loyaltyTransactionId || !UUID_PATTERN.test(loyaltyTransactionId)) {
      return 'skipped';
    }
    const loyaltyTx = await this.creditsRepo.getLoyaltyTransactionById(loyaltyTransactionId);
    if (!loyaltyTx || loyaltyTx.transactionType !== 'REDEEM' || loyaltyTx.organizationEndUserId !== organizationEndUserId) {
      return 'skipped';
    }
    if (loyaltyTx.status === 'CONFIRMED') {
      await this.settleOperation(loyaltyTx, event, tx);
      return 'skipped';
    }
    if (loyaltyTx.status !== 'PENDING') {
      return 'skipped';
    }
    if (Number(loyaltyTx.pointsAmount) !== amount) {
      // `redeem` debits exactly the reserved cost or aborts, so this can't happen for a row this
      // codebase created; refuse to guess which side is right.
      this.logger.error(
        `CreditRedeemed ${event.transactionDigest} amount ${amount} != reserved ${loyaltyTx.pointsAmount} for tx ${loyaltyTx.id}; left PENDING`,
      );
      return 'skipped';
    }

    const confirmed = await this.creditsRepo.confirmPosRedemptionOnChain(
      {
        loyaltyTransactionId: loyaltyTx.id,
        organizationEndUserId,
        pointsAmount: amount,
        digest: event.transactionDigest,
        sender: event.sender,
      },
      tx,
    );
    if (!confirmed) {
      return 'skipped';
    }
    await this.operationsRepo.markSubmittedFromChain(
      { tenantId: loyaltyTx.organizationId, idempotencyKey: loyaltyTx.idempotencyKey, suiTxDigest: event.transactionDigest },
      tx,
    );
    return 'confirmed';
  }

  /**
   * The ledger row is already CONFIRMED, but the operation behind it may not be: the sync path
   * can commit `confirm*OnChain` and then fail on `markSubmitted`, leaving it UNKNOWN. This
   * event proves the effect landed, so settle the operation too. A no-op once it is SUBMITTED.
   */
  private async settleOperation(
    loyaltyTx: { organizationId: string; idempotencyKey: string },
    event: CreditAccountEvent,
    tx: DrizzleDb,
  ): Promise<void> {
    await this.operationsRepo.markSubmittedFromChain(
      { tenantId: loyaltyTx.organizationId, idempotencyKey: loyaltyTx.idempotencyKey, suiTxDigest: event.transactionDigest },
      tx,
    );
  }
}
