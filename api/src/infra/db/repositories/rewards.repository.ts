import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, desc, and, sql, ne, isNull } from 'drizzle-orm';
import {
  DEFAULT_VOUCHER_REFUND_POLICY,
  VOUCHER_MIN_USE_WINDOW_MS,
  type ClaimVoucherResponse,
  type CreateVoucherRequest,
} from '@octap/contracts';
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
  returnVoucherUnit,
  voucherClaimReference,
} from './credits.repository.js';
import {
  acceptCommand,
  canonicalJson,
  lockIdempotencyKey,
  OperationPayloadConflictError,
} from './operations.repository.js';
import { MemberEligibilityError } from './member-eligibility.js';

type Voucher = typeof vouchers.$inferSelect;

/** Inside the minimum use window the contract refuses to claim or grant, so this refuses first. */
const expiresTooSoon = (voucher: Pick<Voucher, 'expiresAt'>): boolean =>
  voucher.expiresAt !== null && voucher.expiresAt.getTime() < Date.now() + VOUCHER_MIN_USE_WINDOW_MS;
type VoucherPatch = Partial<
  Omit<typeof vouchers.$inferInsert, 'id' | 'organizationId' | 'claimedCount' | 'createdAt' | 'updatedAt'>
>;

/** Every claim is accepted under this type, then becomes a reserve (paid) or a grant (free). */
const VOUCHER_CLAIM_COMMAND_TYPE = 'VOUCHER_CLAIM';
/** Worker-signed: freezes a voucher's terms on-chain. */
export const VOUCHER_PUBLISH_COMMAND_TYPE = 'VOUCHER_TERMS_PUBLISH';
/** Worker-signed: records a voucher for a customer without spending their points. */
export const VOUCHER_GRANT_COMMAND_TYPE = 'VOUCHER_GRANT';
/** Customer-signed: marks a voucher used. */
export const VOUCHER_USE_COMMAND_TYPE = 'VOUCHER_USE_RESERVE';
const CLAIM_COMMAND_TYPES = [
  VOUCHER_CLAIM_COMMAND_TYPE,
  VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
  VOUCHER_GRANT_COMMAND_TYPE,
];
/** The promise: once publishing starts, these cannot change. */
const PUBLISHED_FIELDS = [
  'code',
  'title',
  'description',
  'pointsCost',
  'discountType',
  'discountValue',
  'terms',
  'startsAt',
  'expiresAt',
] as const;

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

function sameVoucherField(key: (typeof PUBLISHED_FIELDS)[number], before: unknown, after: unknown): boolean {
  if (before instanceof Date || after instanceof Date) {
    return (before as Date | null)?.getTime() === (after as Date | null)?.getTime();
  }
  if (key === 'discountValue' && before !== null && after !== null && before !== undefined && after !== undefined) {
    return Number(before) === Number(after);
  }
  if (key === 'terms') return canonicalJson(before ?? null) === canonicalJson(after ?? null);
  return (before ?? null) === (after ?? null);
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
    const status = data.status ?? 'ACTIVE';
    return this.db.transaction(async (tx) => {
      const [voucher] = await tx
        .insert(vouchers)
        // A voucher becomes ACTIVE only once the chain holds its terms.
        .values({ ...data, status: status === 'ACTIVE' ? 'DRAFT' : status })
        .onConflictDoNothing({ target: [vouchers.organizationId, vouchers.code] })
        .returning();
      if (!voucher) throw conflict('Voucher code already exists for this organization');
      return status === 'ACTIVE' ? this.queuePublish(tx, voucher) : voucher;
    });
  }

  /** Fixes the promise, including the refund policy current now, and queues it for the chain. */
  private async queuePublish(tx: DrizzleDb, voucher: Voucher, patch: VoucherPatch = {}) {
    const [policy] = await tx
      .select()
      .from(voucherRefundPolicies)
      .where(eq(voucherRefundPolicies.organizationId, voucher.organizationId))
      .orderBy(desc(voucherRefundPolicies.version))
      .limit(1);
    const [updated] = await tx
      .update(vouchers)
      .set({
        ...patch,
        status: 'DRAFT',
        publishStatus: 'PUBLISHING',
        refundPolicySnapshot: policy
          ? { ...policy.policy, version: policy.version }
          : { ...DEFAULT_VOUCHER_REFUND_POLICY },
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, voucher.id))
      .returning();
    await acceptCommand(tx, {
      tenantId: voucher.organizationId,
      // A failed publish can be retried by activating again, so each attempt has its own key.
      idempotencyKey: `voucher-publish:${voucher.id}:${randomUUID()}`,
      commandType: VOUCHER_PUBLISH_COMMAND_TYPE,
      payload: { voucherId: voucher.id },
    });
    return updated;
  }

  /** The chain holds the terms: an activation in progress takes effect. */
  async markVoucherPublished(voucherId: string, suiTermsId: string) {
    await this.db
      .update(vouchers)
      .set({
        publishStatus: 'PUBLISHED',
        suiTermsId,
        // Paused while publishing stays paused.
        status: sql`case when ${vouchers.status} = 'DRAFT' then 'ACTIVE'::voucher_status else ${vouchers.status} end`,
        updatedAt: new Date(),
      })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.publishStatus, 'PUBLISHING')));
  }

  /** The terms never reached the chain, so the voucher can be edited and activated again. */
  async failVoucherPublish(voucherId: string) {
    await this.db
      .update(vouchers)
      .set({ publishStatus: 'FAILED', updatedAt: new Date() })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.publishStatus, 'PUBLISHING')));
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
      const onChain = current.publishStatus === 'PUBLISHING' || current.publishStatus === 'PUBLISHED';
      if (onChain) {
        for (const key of PUBLISHED_FIELDS) {
          if (!sameVoucherField(key, current[key], merged[key])) {
            throw conflict(`${key} cannot change after a voucher has been published; create a new voucher instead`);
          }
        }
      }
      if (merged.totalSupply !== null && merged.totalSupply < current.claimedCount)
        throw conflict('Supply cannot be less than the number already claimed');
      if (merged.status === 'ACTIVE' && expiresTooSoon(merged))
        throw invalid('A voucher must stay valid for at least 24 hours to be activated');
      const depleted = merged.totalSupply !== null && merged.claimedCount >= merged.totalSupply;
      if (patch.status === 'ACTIVE' && depleted) throw conflict('An exhausted voucher cannot be activated');
      const { status: requestedStatus, ...fields } = patch;
      if (requestedStatus === 'ACTIVE' && !onChain) return this.queuePublish(tx, current, fields);
      // DRAFT means an activation in progress here, so it would go ACTIVE when the chain confirms.
      if (requestedStatus === 'DRAFT' && onChain) {
        throw conflict('A published voucher cannot return to DRAFT; pause it instead');
      }
      // A repeat activation while publishing changes nothing: ACTIVE waits for the chain.
      const status =
        requestedStatus === 'ACTIVE' && current.publishStatus === 'PUBLISHING' ? current.status : requestedStatus;
      const [updated] = await tx
        .update(vouchers)
        .set({
          ...fields,
          ...(status ? { status } : {}),
          ...(depleted ? { status: 'DEPLETED' as const } : {}),
          updatedAt: new Date(),
        })
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
    options: { grant?: boolean } = {},
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
        payload: { voucherId, memberId, ...(options.grant ? { grant: true } : {}) },
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
      // A grant gives the voucher whatever its price; the customer spends nothing.
      const pointsCost = options.grant ? 0 : Number(voucher.pointsCost);
      const ownershipId = randomUUID();
      const loyaltyTransactionId =
        pointsCost > 0
          ? await this.holdPoints(tx, { organizationId, memberId, voucher, pointsCost, idempotencyKey, ownershipId })
          : undefined;
      const ownership = await this.issueOwnership(tx, voucher, {
        memberId,
        ownershipId,
        loyaltyTransactionId,
        pendingOperationId: pointsCost > 0 ? undefined : operation.id,
      });

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
          commandType: pointsCost > 0 ? VOUCHER_CLAIM_RESERVE_COMMAND_TYPE : VOUCHER_GRANT_COMMAND_TYPE,
          status: 'PENDING',
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
    if (!voucher.suiTermsId) throw invalid('Voucher terms are not published on-chain');
    if (voucher.startsAt && voucher.startsAt > now) throw invalid('Voucher has not started');
    if (expiresTooSoon(voucher)) throw invalid('Voucher expires too soon to be issued');
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
    if (expiresTooSoon(voucher)) throw invalid('Voucher expires too soon to be issued');

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

  /** Issues the coupon (RESERVED until the chain confirms) and takes its unit from the catalog. */
  private async issueOwnership(
    tx: DrizzleDb,
    voucher: Voucher,
    params: { memberId: string; ownershipId: string; loyaltyTransactionId?: string; pendingOperationId?: string },
  ) {
    // The policy published with the terms, which is what this voucher promised.
    const refundPolicySnapshot = voucher.refundPolicySnapshot ?? { ...DEFAULT_VOUCHER_REFUND_POLICY };
    const [ownership] = await tx
      .insert(voucherOwnerships)
      .values({
        id: params.ownershipId,
        refundPolicySnapshot,
        voucherId: voucher.id,
        organizationEndUserId: params.memberId,
        status: 'RESERVED',
        pendingOperationId: params.pendingOperationId,
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
      pointsCost: o.loyaltyTransactionId ? Number(row.pointsCost) : 0,
      pointsDeducted: row.transactionStatus === 'CONFIRMED' ? Number(row.pointsCost) : 0,
      transactionId: o.loyaltyTransactionId,
      digest: null,
      transactionBytes: null,
      claimedAt: o.claimedAt.toISOString(),
      expiresAt: o.expiresAt?.toISOString() ?? null,
    };
  }

  /** A voucher with its catalog row, for the chain worker and the indexer. */
  async findOwnershipWithVoucher(voucherOwnershipId: string) {
    return this.db.query.voucherOwnerships.findFirst({
      where: eq(voucherOwnerships.id, voucherOwnershipId),
      with: { voucher: true },
    });
  }

  private async operationKey(tx: DrizzleDb, operationId: string | null) {
    if (!operationId) return null;
    const operation = await tx.query.operations.findFirst({ where: eq(operations.id, operationId) });
    return operation ? { tenantId: operation.tenantId, idempotencyKey: operation.idempotencyKey } : null;
  }

  /**
   * The chain recorded a grant or free claim. Returns the command to settle, or null when the voucher
   * is not waiting for this.
   */
  async confirmVoucherGrant(params: { voucherOwnershipId: string; digest: string }, db: DrizzleDb = this.db) {
    return db.transaction(async (tx) => {
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, params.voucherOwnershipId))
        .for('update');
      if (!ownership || ownership.status !== 'RESERVED' || ownership.loyaltyTransactionId) return null;
      const key = await this.operationKey(tx, ownership.pendingOperationId);
      const [updated] = await tx
        .update(voucherOwnerships)
        .set({ status: 'AVAILABLE', pendingOperationId: null, updatedAt: new Date() })
        .where(eq(voucherOwnerships.id, ownership.id))
        .returning();
      const voucher = await tx.query.vouchers.findFirst({ where: eq(vouchers.id, ownership.voucherId) });
      await enqueueWebhookEvent(tx, {
        organizationId: voucher!.organizationId,
        eventType: 'voucher.granted',
        payload: {
          voucherOwnershipId: updated.id,
          voucherId: updated.voucherId,
          organizationEndUserId: updated.organizationEndUserId,
          serialCode: updated.serialCode,
          status: updated.status,
          blockchainDigest: params.digest,
        },
      });
      return { key };
    });
  }

  /** A grant definitively failed on-chain: the voucher is cancelled and its unit returns to the catalog. */
  async failVoucherGrant(voucherOwnershipId: string) {
    await this.db.transaction(async (tx) => {
      const found = await tx.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.id, voucherOwnershipId) });
      if (!found) return;
      await tx.select({ id: vouchers.id }).from(vouchers).where(eq(vouchers.id, found.voucherId)).for('update');
      const [cancelled] = await tx
        .update(voucherOwnerships)
        .set({ status: 'CANCELLED', pendingOperationId: null, updatedAt: new Date() })
        .where(and(eq(voucherOwnerships.id, voucherOwnershipId), eq(voucherOwnerships.status, 'RESERVED')))
        .returning();
      if (cancelled) await returnVoucherUnit(tx, found.voucherId);
    });
  }

  /**
   * Accepts a request to use a voucher and blocks refunds until it settles. Nothing is marked used
   * here: only the customer's signature can do that. A retry under the same key reports the same use.
   */
  async reserveVoucherUse(params: { organizationId: string; serialCode: string; idempotencyKey: string }) {
    return this.db.transaction(async (tx) => {
      await lockIdempotencyKey(tx, params.organizationId, params.idempotencyKey);
      const found = await tx.query.voucherOwnerships.findFirst({
        where: eq(voucherOwnerships.serialCode, params.serialCode),
      });
      if (!found) throw notFound('Voucher serial not found');
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, found.voucherId), eq(vouchers.organizationId, params.organizationId)))
        .for('share');
      if (!voucher) throw notFound('Voucher serial not found');
      await this.requireActiveMember(tx, params.organizationId, found.organizationEndUserId);
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, found.id))
        .for('update');
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: VOUCHER_USE_COMMAND_TYPE,
        payload: { voucherOwnershipId: ownership.id, organizationEndUserId: ownership.organizationEndUserId },
      });
      if (operation.commandType !== VOUCHER_USE_COMMAND_TYPE)
        throw new OperationPayloadConflictError(params.idempotencyKey);
      if (!isNew) {
        if (operation.status === 'PENDING' && !operation.suiTxDigest) {
          // The caller is still working on it: restart its abandonment clock.
          await tx.update(operations).set({ updatedAt: new Date() }).where(eq(operations.id, operation.id));
        }
        return { ownership, voucher, operation, isNew };
      }

      if (ownership.status !== 'AVAILABLE')
        throw invalid(`Voucher cannot be used; status is currently ${ownership.status}`);
      if (ownership.expiresAt && ownership.expiresAt.getTime() <= Date.now()) throw invalid('Voucher has expired');
      if (!voucher.suiTermsId) throw invalid('This voucher has no on-chain record to use');
      if (ownership.pendingOperationId) {
        // A use nobody signed can't land once it is FAILED, so a new attempt replaces it. One already
        // submitted has an outcome to wait for.
        const [replaced] = await tx
          .update(operations)
          .set({ status: 'FAILED', errorMessage: 'Replaced by a new voucher use', updatedAt: new Date() })
          .where(
            and(
              eq(operations.id, ownership.pendingOperationId),
              eq(operations.status, 'PENDING'),
              isNull(operations.suiTxDigest),
            ),
          )
          .returning({ id: operations.id });
        if (!replaced) throw conflict('Another use of this voucher is still in progress');
      }
      await tx
        .update(voucherOwnerships)
        .set({ pendingOperationId: operation.id, updatedAt: new Date() })
        .where(eq(voucherOwnerships.id, ownership.id));
      return { ownership, voucher, operation, isNew };
    });
  }

  /**
   * The chain marked this voucher used, so PostgreSQL follows, whoever sent the transaction. Exactly
   * one AVAILABLE -> REDEEMED transition queues `voucher.redeemed`. Returns null only when the voucher
   * was already taken back here, which `ChainOutcomeReconciler`'s logs surface for a human.
   */
  async confirmVoucherUse(params: { voucherOwnershipId: string; digest: string }, db: DrizzleDb = this.db) {
    return db.transaction(async (tx) => {
      const found = await tx.query.voucherOwnerships.findFirst({
        where: eq(voucherOwnerships.id, params.voucherOwnershipId),
      });
      if (!found) return null;
      const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, found.voucherId)).for('share');
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, found.id))
        .for('update');
      const key = await this.operationKey(tx, ownership.pendingOperationId);
      if (ownership.status === 'REDEEMED') return { ownership, voucher, key, applied: false };
      if (ownership.status !== 'AVAILABLE') return null;
      const [updated] = await tx
        .update(voucherOwnerships)
        .set({ status: 'REDEEMED', redeemedAt: new Date(), pendingOperationId: null, updatedAt: new Date() })
        .where(eq(voucherOwnerships.id, ownership.id))
        .returning();
      await enqueueWebhookEvent(tx, {
        organizationId: voucher.organizationId,
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
          blockchainDigest: params.digest,
        },
      });
      return { ownership: updated, voucher, key, applied: true };
    });
  }

  /**
   * Ends a use that will not land: the voucher stays AVAILABLE and refunds are allowed again.
   * With `onlyIfUnsubmitted` it yields to a finalize that already pinned a digest, and returns false.
   */
  async failVoucherUse(params: { operationId: string; voucherOwnershipId: string; onlyIfUnsubmitted?: boolean }) {
    return this.db.transaction(async (tx) => {
      const [command] = await tx.select().from(operations).where(eq(operations.id, params.operationId)).for('update');
      if (!command) return false;
      if (params.onlyIfUnsubmitted && command.suiTxDigest) return false;
      await tx
        .update(voucherOwnerships)
        .set({ pendingOperationId: null, updatedAt: new Date() })
        .where(
          and(
            eq(voucherOwnerships.id, params.voucherOwnershipId),
            eq(voucherOwnerships.pendingOperationId, params.operationId),
          ),
        );
      return true;
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
