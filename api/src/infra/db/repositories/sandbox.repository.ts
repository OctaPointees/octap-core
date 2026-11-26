import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { sandboxCreditBalances, sandboxLoyaltyTransactions } from '../schema/sandbox.schema.js';
import { withTenant } from '../rls.js';
import { withActiveMember } from './member-eligibility.js';
import { hashPayload, OperationPayloadConflictError } from './operations.repository.js';

export type SandboxTransaction = typeof sandboxLoyaltyTransactions.$inferSelect;
export type SandboxBalance = Pick<
  typeof sandboxCreditBalances.$inferSelect,
  'confirmedBalance' | 'pendingRedemption' | 'lifetimeEarned' | 'lifetimeRedeemed'
>;

/** An unsigned sandbox hold is released after this long, like a live one (`pos-redemption.service.ts`). */
export const SANDBOX_HOLD_TTL_MS = 30 * 60 * 1000;

const ZERO: SandboxBalance = { confirmedBalance: 0, pendingRedemption: 0, lifetimeEarned: 0, lifetimeRedeemed: 0 };

/** The member's sandbox balance cannot cover the redemption: `available` is what it can. */
export class SandboxInsufficientPointsError extends Error {
  constructor(readonly available: number) {
    super(`Insufficient sandbox points: ${available} available`);
  }
}

/** Finalize refused: the hold was released or has already failed. */
export class SandboxHoldReleasedError extends Error {}

/** A synthetic id in the `digest` slot: never a Sui digest, never resolvable on-chain. */
export function sandboxDigest(): string {
  return `sandbox_${randomUUID().replaceAll('-', '')}`;
}

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * The sandbox ledger (OCT-297). Every write runs under `withActiveMember` (organization and member
 * eligibility, then the tenant's RLS context), the same gate as a live earn or reserve; every read
 * under `withTenant`. It touches only the two sandbox tables: nothing here can reach a real
 * balance, the outbox, a durable command or the chain.
 */
@Injectable()
export class SandboxRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** A CONFIRMED earn, credited at once. A replay of the same key and payload returns the first one. */
  async earn(params: {
    organizationId: string;
    organizationEndUserId: string;
    credentialId: string;
    purchaseAmount: number;
    points: number;
    idempotencyKey: string;
    receiptReference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ transaction: SandboxTransaction; balance: SandboxBalance }> {
    const payloadHash = hashPayload({
      type: 'EARN',
      organizationEndUserId: params.organizationEndUserId,
      purchaseAmount: params.purchaseAmount,
      receiptReference: params.receiptReference ?? null,
      metadata: params.metadata ?? null,
    });
    return withActiveMember(this.db, params.organizationId, params.organizationEndUserId, async (tx) => {
      const [inserted] = await tx
        .insert(sandboxLoyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          credentialId: params.credentialId,
          transactionType: 'EARN',
          status: 'CONFIRMED',
          pointsAmount: params.points,
          purchaseAmount: params.purchaseAmount,
          idempotencyKey: params.idempotencyKey,
          payloadHash,
          receiptReference: params.receiptReference,
          metadata: params.metadata ?? {},
          digest: sandboxDigest(),
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        const existing = await this.byKey(tx, params.organizationId, params.idempotencyKey);
        if (existing.payloadHash !== payloadHash) throw new OperationPayloadConflictError(params.idempotencyKey);
        return { transaction: existing, balance: await this.readBalance(tx, params.organizationEndUserId) };
      }
      const [balance] = await tx
        .insert(sandboxCreditBalances)
        .values({
          organizationEndUserId: params.organizationEndUserId,
          organizationId: params.organizationId,
          confirmedBalance: params.points,
          lifetimeEarned: params.points,
        })
        .onConflictDoUpdate({
          target: sandboxCreditBalances.organizationEndUserId,
          set: {
            confirmedBalance: sql`${sandboxCreditBalances.confirmedBalance} + ${params.points}`,
            lifetimeEarned: sql`${sandboxCreditBalances.lifetimeEarned} + ${params.points}`,
            updatedAt: new Date(),
          },
        })
        .returning();
      return { transaction: inserted, balance };
    });
  }

  /**
   * Holds `points` of the sandbox balance under a PENDING redemption. A replay of the same key and
   * payload returns the same hold (or its outcome). Releases the member's abandoned holds first,
   * before the replay too, so a retry after the hold expired answers FAILED, never a dead PENDING.
   */
  async reserve(params: {
    organizationId: string;
    organizationEndUserId: string;
    credentialId: string;
    points: number;
    idempotencyKey: string;
    orderReference: string;
    benefit: Record<string, unknown>;
  }): Promise<SandboxTransaction> {
    const payloadHash = hashPayload({
      type: 'REDEEM',
      organizationEndUserId: params.organizationEndUserId,
      pointsAmount: params.points,
      ...params.benefit,
    });
    return withActiveMember(this.db, params.organizationId, params.organizationEndUserId, async (tx) => {
      await this.releaseAbandoned(tx, params.organizationEndUserId);
      const existing = await this.byKey(tx, params.organizationId, params.idempotencyKey, false);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new OperationPayloadConflictError(params.idempotencyKey);
        return existing;
      }
      const balance = await this.lockBalance(tx, params.organizationId, params.organizationEndUserId);
      const available = balance.confirmedBalance - balance.pendingRedemption;
      if (available < params.points) throw new SandboxInsufficientPointsError(available);
      const [hold] = await tx
        .insert(sandboxLoyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          credentialId: params.credentialId,
          transactionType: 'REDEEM',
          status: 'PENDING',
          pointsAmount: params.points,
          idempotencyKey: params.idempotencyKey,
          payloadHash,
          receiptReference: params.orderReference,
          metadata: { benefit: params.benefit },
          digest: sandboxDigest(),
        })
        .onConflictDoNothing()
        .returning();
      // A concurrent reserve under the same key won the insert: answer with its hold.
      if (!hold) return this.reserveReplay(tx, params.organizationId, params.idempotencyKey, payloadHash);
      await tx
        .update(sandboxCreditBalances)
        .set({
          pendingRedemption: sql`${sandboxCreditBalances.pendingRedemption} + ${params.points}`,
          updatedAt: new Date(),
        })
        .where(eq(sandboxCreditBalances.organizationEndUserId, params.organizationEndUserId));
      return hold;
    });
  }

  /**
   * Settles a sandbox hold by its digest, as the customer's device would with a signature. The
   * digest is the only thing that identifies it (finalize carries no key), so the lookup is the
   * one RLS exception here; everything after it runs under the hold's organization. Returns
   * `undefined` for an unknown digest. An expired hold is released in a transaction that commits,
   * and only then refused.
   */
  async finalize(
    digest: string,
    now = new Date(),
  ): Promise<{ transaction: SandboxTransaction; balance: SandboxBalance } | undefined> {
    const [found] = await this.db
      .select({ organizationId: sandboxLoyaltyTransactions.organizationId })
      .from(sandboxLoyaltyTransactions)
      .where(
        and(eq(sandboxLoyaltyTransactions.digest, digest), eq(sandboxLoyaltyTransactions.transactionType, 'REDEEM')),
      );
    if (!found) return undefined;
    const outcome = await withTenant(this.db, found.organizationId, async (tx) => {
      const [hold] = await tx
        .select()
        .from(sandboxLoyaltyTransactions)
        .where(eq(sandboxLoyaltyTransactions.digest, digest))
        .for('update');
      if (hold.status === 'CONFIRMED') {
        return { transaction: hold, balance: await this.readBalance(tx, hold.organizationEndUserId) };
      }
      if (hold.status !== 'PENDING')
        throw new SandboxHoldReleasedError('This reserved redemption was released; reserve again');
      await this.lockBalance(tx, hold.organizationId, hold.organizationEndUserId);
      if (now.getTime() - hold.createdAt.getTime() > SANDBOX_HOLD_TTL_MS) {
        await this.settleHold(tx, hold, 'FAILED');
        return 'EXPIRED' as const;
      }
      const [confirmed] = await this.settleHold(tx, hold, 'CONFIRMED');
      return { transaction: confirmed, balance: await this.readBalance(tx, hold.organizationEndUserId) };
    });
    // Refused outside the transaction: a throw inside it would roll the release back.
    if (outcome === 'EXPIRED')
      throw new SandboxHoldReleasedError('This reserved redemption expired unsigned and was released; reserve again');
    return outcome;
  }

  /** The member's sandbox balance, zero before their first sandbox earn. Releases abandoned holds first. */
  async balance(organizationId: string, organizationEndUserId: string): Promise<SandboxBalance> {
    return withTenant(this.db, organizationId, async (tx) => {
      await this.releaseAbandoned(tx, organizationEndUserId);
      return this.readBalance(tx, organizationEndUserId);
    });
  }

  /**
   * Newest first; `null` when `cursor` is not one of this member's sandbox transactions. Releases
   * abandoned holds first, as `balance` does, so history and balance agree.
   */
  async listByMember(organizationId: string, organizationEndUserId: string, limit: number, cursor?: string) {
    return withTenant(this.db, organizationId, async (tx) => {
      await this.releaseAbandoned(tx, organizationEndUserId);
      const ofMember = and(
        eq(sandboxLoyaltyTransactions.organizationId, organizationId),
        eq(sandboxLoyaltyTransactions.organizationEndUserId, organizationEndUserId),
      );
      if (cursor) {
        const [anchor] = await tx
          .select({ id: sandboxLoyaltyTransactions.id })
          .from(sandboxLoyaltyTransactions)
          .where(and(ofMember, eq(sandboxLoyaltyTransactions.id, cursor)));
        if (!anchor) return null;
      }
      const rows = await tx
        .select()
        .from(sandboxLoyaltyTransactions)
        .where(
          and(
            ofMember,
            cursor
              ? sql`(${sandboxLoyaltyTransactions.createdAt}, ${sandboxLoyaltyTransactions.id}) < (select a.created_at, a.id from ${sandboxLoyaltyTransactions} a where a.id = ${cursor})`
              : undefined,
          ),
        )
        .orderBy(desc(sandboxLoyaltyTransactions.createdAt), desc(sandboxLoyaltyTransactions.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      if (more) rows.pop();
      return { rows, nextCursor: more ? rows.at(-1)!.id : null };
    });
  }

  private async byKey(tx: Tx, organizationId: string, idempotencyKey: string): Promise<SandboxTransaction>;
  private async byKey(
    tx: Tx,
    organizationId: string,
    idempotencyKey: string,
    required: false,
  ): Promise<SandboxTransaction | undefined>;
  private async byKey(tx: Tx, organizationId: string, idempotencyKey: string, required = true) {
    const [row] = await tx
      .select()
      .from(sandboxLoyaltyTransactions)
      .where(
        and(
          eq(sandboxLoyaltyTransactions.organizationId, organizationId),
          eq(sandboxLoyaltyTransactions.idempotencyKey, idempotencyKey),
        ),
      );
    if (!row && required) throw new Error(`Sandbox transaction under key ${idempotencyKey} vanished`);
    return row;
  }

  private async reserveReplay(tx: Tx, organizationId: string, idempotencyKey: string, payloadHash: string) {
    const existing = await this.byKey(tx, organizationId, idempotencyKey);
    if (existing.payloadHash !== payloadHash) throw new OperationPayloadConflictError(idempotencyKey);
    return existing;
  }

  private async readBalance(tx: Tx, organizationEndUserId: string): Promise<SandboxBalance> {
    const [row] = await tx
      .select()
      .from(sandboxCreditBalances)
      .where(eq(sandboxCreditBalances.organizationEndUserId, organizationEndUserId));
    return row ?? ZERO;
  }

  /** The balance row, created at zero if needed, locked until the transaction ends. */
  private async lockBalance(tx: Tx, organizationId: string, organizationEndUserId: string): Promise<SandboxBalance> {
    await tx.insert(sandboxCreditBalances).values({ organizationEndUserId, organizationId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(sandboxCreditBalances)
      .where(eq(sandboxCreditBalances.organizationEndUserId, organizationEndUserId))
      .for('update');
    return row;
  }

  /** Moves a PENDING hold out of `pendingRedemption`: spent when CONFIRMED, returned when FAILED. */
  private async settleHold(tx: Tx, hold: SandboxTransaction, status: 'CONFIRMED' | 'FAILED') {
    const settled = await tx
      .update(sandboxLoyaltyTransactions)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(sandboxLoyaltyTransactions.id, hold.id), eq(sandboxLoyaltyTransactions.status, 'PENDING')))
      .returning();
    if (settled.length === 0) return settled;
    const spent = status === 'CONFIRMED' ? hold.pointsAmount : 0;
    await tx
      .update(sandboxCreditBalances)
      .set({
        pendingRedemption: sql`${sandboxCreditBalances.pendingRedemption} - ${hold.pointsAmount}`,
        confirmedBalance: sql`${sandboxCreditBalances.confirmedBalance} - ${spent}`,
        lifetimeRedeemed: sql`${sandboxCreditBalances.lifetimeRedeemed} + ${spent}`,
        updatedAt: new Date(),
      })
      .where(eq(sandboxCreditBalances.organizationEndUserId, hold.organizationEndUserId));
    return settled;
  }

  /** Releases the member's PENDING holds older than `SANDBOX_HOLD_TTL_MS`. */
  private async releaseAbandoned(tx: Tx, organizationEndUserId: string): Promise<void> {
    const stale = await tx
      .select()
      .from(sandboxLoyaltyTransactions)
      .where(
        and(
          eq(sandboxLoyaltyTransactions.organizationEndUserId, organizationEndUserId),
          eq(sandboxLoyaltyTransactions.transactionType, 'REDEEM'),
          eq(sandboxLoyaltyTransactions.status, 'PENDING'),
          lt(sandboxLoyaltyTransactions.createdAt, new Date(Date.now() - SANDBOX_HOLD_TTL_MS)),
        ),
      )
      .for('update');
    for (const hold of stale) await this.settleHold(tx, hold, 'FAILED');
  }
}
