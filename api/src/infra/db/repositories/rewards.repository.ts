import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, desc, and, sql, ne } from 'drizzle-orm';
import { DEFAULT_VOUCHER_REFUND_POLICY, type ClaimVoucherResponse, type CreateVoucherRequest } from '@octap/contracts';
import { voucherRefundPolicies } from '../schema/voucher-refund-policies.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { operations } from '../schema/operations.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { organizationEndUsers, endUsers } from '../schema/members.schema.js';
import { enqueueWebhookEvent } from './webhooks.repository.js';
import {
  ABANDONED_POS_HOLD_GRACE_MS,
  VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
  releaseAbandonedPosHolds,
  expireDueBuckets,
  voucherClaimReference,
} from './credits.repository.js';
import { acceptCommand, lockIdempotencyKey, OperationPayloadConflictError } from './operations.repository.js';
import { MemberEligibilityError } from './member-eligibility.js';

type Voucher = typeof vouchers.$inferSelect;
type VoucherPatch = Partial<
  Omit<typeof vouchers.$inferInsert, 'id' | 'organizationId' | 'claimedCount' | 'createdAt' | 'updatedAt'>
>;

/** A free claim completes at once; a paid one is accepted under this type, then becomes a reserve. */
const VOUCHER_CLAIM_COMMAND_TYPE = 'VOUCHER_CLAIM';
const CLAIM_COMMAND_TYPES = [VOUCHER_CLAIM_COMMAND_TYPE, VOUCHER_CLAIM_RESERVE_COMMAND_TYPE];

/** A voucher rule a request broke. `RewardsService` maps `kind` to the HTTP status. */
export class RewardsRuleError extends Error {
  constructor(
    readonly kind: 'NOT_FOUND' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'RewardsRuleError';
  }
}

const notFound = (message: string) => new RewardsRuleError('NOT_FOUND', message);
const conflict = (message: string) => new RewardsRuleError('CONFLICT', message);
const invalid = (message: string) => new RewardsRuleError('INVALID', message);

@Injectable()
export class RewardsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async createVoucher(
    data: Omit<CreateVoucherRequest, 'startsAt' | 'expiresAt'> & {
      organizationId: string;
      startsAt?: Date;
      expiresAt?: Date;
    },
  ) {
    const [voucher] = await this.db
      .insert(vouchers)
      .values({ ...data, status: data.status ?? 'ACTIVE' })
      .onConflictDoNothing({ target: [vouchers.organizationId, vouchers.code] })
      .returning();
    if (!voucher) throw conflict('Voucher code already exists for this organization');
    return voucher;
  }

  async findVoucherById(id: string) {
    return this.db.query.vouchers.findFirst({ where: eq(vouchers.id, id) });
  }

  async findVoucherByCode(organizationId: string, code: string) {
    return this.db.query.vouchers.findFirst({
      where: and(eq(vouchers.organizationId, organizationId), eq(vouchers.code, code)),
    });
  }

  async listVouchersByOrganization(organizationId: string) {
    return this.db.query.vouchers.findMany({
      where: eq(vouchers.organizationId, organizationId),
      orderBy: [desc(vouchers.createdAt)],
    });
  }

  /** Serialize edits with claims; the domain validator sees the merged row under the lock. */
  async updateVoucher(organizationId: string, id: string, patch: VoucherPatch, validate: (merged: Voucher) => void) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, id), eq(vouchers.organizationId, organizationId)))
        .for('update');
      if (!current) throw notFound('Voucher not found');
      const merged = { ...current, ...patch };
      validate(merged);
      const hasClaims =
        current.claimedCount > 0 ||
        !!(await tx.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.voucherId, id) }));
      if (hasClaims) {
        for (const key of ['code', 'pointsCost', 'discountType', 'discountValue', 'startsAt', 'expiresAt'] as const) {
          const oldValue = current[key] instanceof Date ? current[key].getTime() : current[key];
          const newValue = merged[key] instanceof Date ? merged[key].getTime() : merged[key];
          const equal =
            key === 'discountValue' && oldValue !== null && newValue !== null
              ? Number(oldValue) === Number(newValue)
              : oldValue === newValue;
          if (!equal) throw conflict(`${key} cannot change after a voucher has been claimed`);
        }
      }
      if (merged.totalSupply !== null && merged.totalSupply < current.claimedCount)
        throw conflict('Supply cannot be less than the number already claimed');
      if (merged.status === 'ACTIVE' && merged.expiresAt && merged.expiresAt.getTime() <= Date.now())
        throw invalid('An expired voucher cannot be activated');
      const depleted = merged.totalSupply !== null && merged.claimedCount >= merged.totalSupply;
      if (patch.status === 'ACTIVE' && depleted) throw conflict('An exhausted voucher cannot be activated');
      const [updated] = await tx
        .update(vouchers)
        .set({ ...patch, ...(depleted ? { status: 'DEPLETED' as const } : {}), updatedAt: new Date() })
        .where(eq(vouchers.id, id))
        .returning();
      return updated;
    });
  }

  private async requireActiveMember(tx: DrizzleDb, organizationId: string, memberId: string) {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('share');
    if (!org || org.status !== 'ACTIVE') throw new MemberEligibilityError('FORBIDDEN', 'Organization is not active');
    const [member] = await tx
      .select({ status: organizationEndUsers.status, userStatus: endUsers.status })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
      .where(and(eq(organizationEndUsers.id, memberId), eq(organizationEndUsers.organizationId, organizationId)))
      .for('share');
    if (!member) throw notFound('Member was not found for this organization');
    if (member.status !== 'ACTIVE' || member.userStatus !== 'ACTIVE')
      throw new MemberEligibilityError('FORBIDDEN', 'Member is not active');
  }

  /**
   * Atomically reserve stock and spendable points; only a chain verdict can confirm a paid claim.
   * Throws `RewardsRuleError` or `OperationPayloadConflictError`, which `RewardsService` maps.
   */
  async claimVoucher(
    organizationId: string,
    voucherId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<ClaimVoucherResponse> {
    // Commit cleanup even if the subsequent claim fails its stock/balance checks.
    await this.db.transaction((tx) =>
      releaseAbandonedPosHolds(tx, { organizationId, organizationEndUserId: memberId }, ABANDONED_POS_HOLD_GRACE_MS, {
        exceptIdempotencyKey: idempotencyKey,
      }),
    );
    return this.db.transaction(async (tx) => {
      await lockIdempotencyKey(tx, organizationId, idempotencyKey);
      const previous = await tx.query.operations.findFirst({
        where: and(eq(operations.tenantId, organizationId), eq(operations.idempotencyKey, idempotencyKey)),
      });
      if (previous && !CLAIM_COMMAND_TYPES.includes(previous.commandType))
        throw new OperationPayloadConflictError(idempotencyKey);
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: organizationId,
        idempotencyKey,
        commandType: VOUCHER_CLAIM_COMMAND_TYPE,
        payload: { voucherId, memberId },
      });
      if (!isNew) return this.resumeClaim(tx, organizationId, operation);

      const voucher = await this.lockClaimableVoucher(tx, organizationId, voucherId, memberId);
      const usedKey = await tx.query.loyaltyTransactions.findFirst({
        where: and(
          eq(loyaltyTransactions.organizationId, organizationId),
          eq(loyaltyTransactions.idempotencyKey, idempotencyKey),
        ),
      });
      if (usedKey) throw new OperationPayloadConflictError(idempotencyKey);
      const pointsCost = Number(voucher.pointsCost);
      const ownershipId = randomUUID();
      const loyaltyTransactionId =
        pointsCost > 0
          ? await this.holdPoints(tx, { organizationId, memberId, voucher, pointsCost, idempotencyKey, ownershipId })
          : undefined;
      const ownership = await this.issueOwnership(tx, voucher, { memberId, ownershipId, loyaltyTransactionId });

      const result: ClaimVoucherResponse = {
        voucherOwnershipId: ownership.id,
        refundPolicy: ownership.refundPolicySnapshot,
        voucherId,
        organizationEndUserId: memberId,
        serialCode: ownership.serialCode,
        status: ownership.status,
        pointsDeducted: 0,
        pointsCost,
        transactionId: loyaltyTransactionId ?? null,
        digest: null,
        transactionBytes: null,
        claimedAt: ownership.claimedAt.toISOString(),
        expiresAt: ownership.expiresAt?.toISOString() ?? null,
      };
      await tx
        .update(operations)
        .set({
          commandType: pointsCost > 0 ? VOUCHER_CLAIM_RESERVE_COMMAND_TYPE : VOUCHER_CLAIM_COMMAND_TYPE,
          status: pointsCost > 0 ? 'PENDING' : 'COMPLETED',
          payload: {
            voucherId,
            memberId,
            organizationEndUserId: memberId,
            pointsAmount: pointsCost,
            voucherOwnershipId: ownershipId,
            result,
          },
          updatedAt: new Date(),
        })
        .where(eq(operations.id, operation.id));
      return result;
    });
  }

  /** A retry under an accepted key: report the claim's current state instead of claiming again. */
  private async resumeClaim(tx: DrizzleDb, organizationId: string, operation: typeof operations.$inferSelect) {
    const saved = operation.payload as { result?: ClaimVoucherResponse };
    if (!saved?.result) throw conflict('Claim has no saved result; inspect the original operation');
    // A caller actively continuing an unsigned claim refreshes its abandonment clock.
    await tx
      .update(operations)
      .set({ updatedAt: new Date() })
      .where(
        and(eq(operations.id, operation.id), eq(operations.status, 'PENDING'), sql`${operations.suiTxDigest} is null`),
      );
    return this.getClaim(organizationId, saved.result.voucherOwnershipId, tx);
  }

  /** Locks the catalog row (stock) and checks this member may claim it now. */
  private async lockClaimableVoucher(tx: DrizzleDb, organizationId: string, voucherId: string, memberId: string) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.organizationId, organizationId)))
      .for('update');
    if (!voucher) throw notFound('Voucher not found');
    await this.requireActiveMember(tx, organizationId, memberId);
    const now = new Date();
    if (voucher.status !== 'ACTIVE') throw invalid(`Voucher is not active (current status: ${voucher.status})`);
    if (voucher.startsAt && voucher.startsAt > now) throw invalid('Voucher has not started');
    if (voucher.expiresAt && voucher.expiresAt <= now) throw invalid('Voucher has expired');
    if (voucher.totalSupply !== null && voucher.claimedCount >= voucher.totalSupply)
      throw invalid('Voucher is completely depleted');
    const existing = await tx.query.voucherOwnerships.findFirst({
      where: and(
        eq(voucherOwnerships.voucherId, voucherId),
        eq(voucherOwnerships.organizationEndUserId, memberId),
        ne(voucherOwnerships.status, 'CANCELLED'),
      ),
    });
    if (existing) throw invalid('Voucher has already been claimed by this member');
    const pointsCost = Number(voucher.pointsCost);
    if (!Number.isSafeInteger(pointsCost) || pointsCost < 0) throw invalid('Voucher points cost is invalid');
    return voucher;
  }

  /** Holds `pointsCost` in `pendingRedemption` behind a PENDING REDEEM; returns that transaction's id. */
  private async holdPoints(
    tx: DrizzleDb,
    params: {
      organizationId: string;
      memberId: string;
      voucher: Voucher;
      pointsCost: number;
      idempotencyKey: string;
      ownershipId: string;
    },
  ) {
    const { organizationId, memberId, voucher, pointsCost } = params;
    // This takes the same ownership lock used by other balance writers before spending.
    await expireDueBuckets(tx, { organizationId, organizationEndUserId: memberId });
    const balance = await tx.query.creditOwnerships.findFirst({
      where: eq(creditOwnerships.organizationEndUserId, memberId),
    });
    if (
      balance &&
      (!Number.isSafeInteger(Number(balance.confirmedBalance)) ||
        !Number.isSafeInteger(Number(balance.pendingRedemption)) ||
        Number(balance.pendingRedemption) < 0 ||
        !Number.isSafeInteger(Number(balance.lifetimeRedeemed) + pointsCost))
    )
      throw invalid('Member balance exceeds supported point precision');
    const available = balance ? Number(balance.confirmedBalance) - Number(balance.pendingRedemption) : 0;
    if (!balance || available < pointsCost) throw invalid('Insufficient points');
    if (!balance.suiCreditAccountId) throw invalid('Member has no on-chain CreditAccount yet');
    // The ownership lock can wait on another balance writer. Recheck expiry after waiting.
    if (voucher.expiresAt && voucher.expiresAt.getTime() <= Date.now()) throw invalid('Voucher has expired');

    const [transaction] = await tx
      .insert(loyaltyTransactions)
      .values({
        organizationId,
        organizationEndUserId: memberId,
        transactionType: 'REDEEM',
        pointsAmount: pointsCost,
        idempotencyKey: params.idempotencyKey,
        receiptReference: voucherClaimReference(params.ownershipId),
        status: 'PENDING',
        metadata: { voucherId: voucher.id, voucherOwnershipId: params.ownershipId },
      })
      .returning();
    await tx
      .update(creditOwnerships)
      .set({ pendingRedemption: Number(balance.pendingRedemption) + pointsCost, updatedAt: new Date() })
      .where(eq(creditOwnerships.id, balance.id));
    return transaction.id;
  }

  /** Issues the coupon (RESERVED until a paid claim confirms) and takes its unit from the catalog. */
  private async issueOwnership(
    tx: DrizzleDb,
    voucher: Voucher,
    params: { memberId: string; ownershipId: string; loyaltyTransactionId?: string },
  ) {
    const [policy] = await tx
      .select()
      .from(voucherRefundPolicies)
      .where(eq(voucherRefundPolicies.organizationId, voucher.organizationId))
      .orderBy(desc(voucherRefundPolicies.version))
      .limit(1);
    const refundPolicySnapshot = policy
      ? { ...policy.policy, version: policy.version }
      : { ...DEFAULT_VOUCHER_REFUND_POLICY };
    const [ownership] = await tx
      .insert(voucherOwnerships)
      .values({
        id: params.ownershipId,
        refundPolicySnapshot,
        voucherId: voucher.id,
        organizationEndUserId: params.memberId,
        status: params.loyaltyTransactionId ? 'RESERVED' : 'AVAILABLE',
        serialCode: `${voucher.code.toUpperCase()}-${randomBytes(8).toString('hex').toUpperCase()}`,
        loyaltyTransactionId: params.loyaltyTransactionId,
        expiresAt: voucher.expiresAt,
      })
      .returning();
    const claimedCount = voucher.claimedCount + 1;
    await tx
      .update(vouchers)
      .set({
        claimedCount,
        status: voucher.totalSupply !== null && claimedCount >= voucher.totalSupply ? 'DEPLETED' : 'ACTIVE',
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, voucher.id));
    return ownership;
  }

  /** Tenant-scoped persisted state, also used after recovery/indexer settlement. */
  async getClaim(organizationId: string, ownershipId: string, db: DrizzleDb = this.db): Promise<ClaimVoucherResponse> {
    const [row] = await db
      .select({
        ownership: voucherOwnerships,
        pointsCost: vouchers.pointsCost,
        transactionStatus: loyaltyTransactions.status,
      })
      .from(voucherOwnerships)
      .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
      .leftJoin(loyaltyTransactions, eq(loyaltyTransactions.id, voucherOwnerships.loyaltyTransactionId))
      .where(and(eq(voucherOwnerships.id, ownershipId), eq(vouchers.organizationId, organizationId)));
    if (!row) throw notFound('Voucher claim not found');
    const o = row.ownership;
    return {
      voucherOwnershipId: o.id,
      refundPolicy: o.refundPolicySnapshot,
      voucherId: o.voucherId,
      organizationEndUserId: o.organizationEndUserId,
      serialCode: o.serialCode,
      status: o.status,
      pointsCost: Number(row.pointsCost),
      pointsDeducted: row.transactionStatus === 'CONFIRMED' ? Number(row.pointsCost) : 0,
      transactionId: o.loyaltyTransactionId,
      digest: null,
      transactionBytes: null,
      claimedAt: o.claimedAt.toISOString(),
      expiresAt: o.expiresAt?.toISOString() ?? null,
    };
  }

  async findOwnershipBySerial(serialCode: string) {
    return this.db.query.voucherOwnerships.findFirst({
      where: eq(voucherOwnerships.serialCode, serialCode),
      with: { voucher: true },
    });
  }

  async redeemVoucher(organizationId: string, serialCode: string) {
    return this.db.transaction(async (tx) => {
      const found = await tx.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.serialCode, serialCode) });
      if (!found) throw notFound('Voucher serial not found');
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, found.voucherId), eq(vouchers.organizationId, organizationId)))
        .for('share');
      if (!voucher) throw notFound('Voucher serial not found');
      await this.requireActiveMember(tx, organizationId, found.organizationEndUserId);
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, found.id))
        .for('update');
      if (ownership.status !== 'AVAILABLE')
        throw invalid(`Voucher cannot be used; status is currently ${ownership.status}`);
      if (ownership.expiresAt && ownership.expiresAt.getTime() <= Date.now()) throw invalid('Voucher has expired');
      // Pausing stops new claims; issued vouchers retain their promised benefit and expiry.
      const [updated] = await tx
        .update(voucherOwnerships)
        .set({ status: 'REDEEMED', redeemedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(voucherOwnerships.id, ownership.id), eq(voucherOwnerships.status, 'AVAILABLE')))
        .returning();
      await enqueueWebhookEvent(tx, {
        organizationId,
        eventType: 'voucher.redeemed',
        payload: {
          voucherOwnershipId: updated.id,
          voucherId: updated.voucherId,
          organizationEndUserId: updated.organizationEndUserId,
          serialCode: updated.serialCode,
          status: updated.status,
          redeemedAt: updated.redeemedAt!.toISOString(),
          voucherTitle: voucher.title,
          discountType: voucher.discountType,
          discountValue: voucher.discountValue,
        },
      });
      return { ownership: updated, voucher };
    });
  }

  async listOwnershipsByMember(organizationEndUserId: string) {
    return this.db.query.voucherOwnerships.findMany({
      where: eq(voucherOwnerships.organizationEndUserId, organizationEndUserId),
      with: { voucher: true },
      orderBy: [desc(voucherOwnerships.claimedAt)],
    });
  }
}
