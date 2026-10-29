import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, desc, and, sql, ne } from 'drizzle-orm';
import type { ClaimVoucherResponse, CreateVoucherRequest } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { operations } from '../schema/operations.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { organizationEndUsers, endUsers } from '../schema/members.schema.js';
import { expireDueBuckets } from './credits.repository.js';
import { acceptCommand, OperationPayloadConflictError } from './operations.repository.js';

type Voucher = typeof vouchers.$inferSelect;
type VoucherPatch = Partial<
  Omit<typeof vouchers.$inferInsert, 'id' | 'organizationId' | 'claimedCount' | 'createdAt' | 'updatedAt'>
>;

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
    if (!voucher) throw new ConflictException('Voucher code already exists for this organization');
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
      if (!current) throw new NotFoundException('Voucher not found');
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
          if (!equal) throw new ConflictException(`${key} cannot change after a voucher has been claimed`);
        }
      }
      if (merged.totalSupply !== null && merged.totalSupply < current.claimedCount)
        throw new ConflictException('Supply cannot be less than the number already claimed');
      if (merged.status === 'ACTIVE' && merged.expiresAt && merged.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('An expired voucher cannot be activated');
      const depleted = merged.totalSupply !== null && merged.claimedCount >= merged.totalSupply;
      if (patch.status === 'ACTIVE' && depleted)
        throw new ConflictException('An exhausted voucher cannot be activated');
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
    if (!org || org.status !== 'ACTIVE') throw new BadRequestException('Organization is not active');
    const [member] = await tx
      .select({ status: organizationEndUsers.status, userStatus: endUsers.status })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
      .where(and(eq(organizationEndUsers.id, memberId), eq(organizationEndUsers.organizationId, organizationId)))
      .for('share');
    if (!member) throw new NotFoundException('Member was not found for this organization');
    if (member.status !== 'ACTIVE' || member.userStatus !== 'ACTIVE')
      throw new BadRequestException('Member is not active');
  }

  /** Atomically reserve stock and spendable points; only a chain verdict can confirm a paid claim. */
  async claimVoucher(
    organizationId: string,
    voucherId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<ClaimVoucherResponse> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + idempotencyKey}, 0))`,
        );
        const previous = await tx.query.operations.findFirst({
          where: and(eq(operations.tenantId, organizationId), eq(operations.idempotencyKey, idempotencyKey)),
        });
        if (previous && !['VOUCHER_CLAIM', 'CREDIT_POS_REDEEM_RESERVE'].includes(previous.commandType))
          throw new OperationPayloadConflictError(idempotencyKey);
        const { operation, isNew } = await acceptCommand(tx, {
          tenantId: organizationId,
          idempotencyKey,
          commandType: 'CREDIT_POS_REDEEM_RESERVE',
          payload: { voucherId, memberId },
        });
        if (!isNew) {
          const saved = operation.payload as { result?: ClaimVoucherResponse };
          if (!saved?.result) throw new ConflictException('Claim has no saved result; inspect the original operation');
          const current = await this.getClaim(organizationId, saved.result.voucherOwnershipId, tx);
          return current;
        }
        const [voucher] = await tx
          .select()
          .from(vouchers)
          .where(and(eq(vouchers.id, voucherId), eq(vouchers.organizationId, organizationId)))
          .for('update');
        if (!voucher) throw new NotFoundException('Voucher not found');
        await this.requireActiveMember(tx, organizationId, memberId);
        const now = new Date();
        if (voucher.status !== 'ACTIVE')
          throw new BadRequestException(`Voucher is not active (current status: ${voucher.status})`);
        if (voucher.startsAt && voucher.startsAt > now) throw new BadRequestException('Voucher has not started');
        if (voucher.expiresAt && voucher.expiresAt <= now) throw new BadRequestException('Voucher has expired');
        if (voucher.totalSupply !== null && voucher.claimedCount >= voucher.totalSupply)
          throw new BadRequestException('Voucher is completely depleted');
        const existing = await tx.query.voucherOwnerships.findFirst({
          where: and(
            eq(voucherOwnerships.voucherId, voucherId),
            eq(voucherOwnerships.organizationEndUserId, memberId),
            ne(voucherOwnerships.status, 'CANCELLED'),
          ),
        });
        if (existing) throw new BadRequestException('Voucher has already been claimed by this member');
        const pointsCost = Number(voucher.pointsCost);
        if (!Number.isSafeInteger(pointsCost) || pointsCost < 0)
          throw new BadRequestException('Voucher points cost is invalid');
        const usedKey = await tx.query.loyaltyTransactions.findFirst({
          where: and(
            eq(loyaltyTransactions.organizationId, organizationId),
            eq(loyaltyTransactions.idempotencyKey, idempotencyKey),
          ),
        });
        if (usedKey) throw new OperationPayloadConflictError(idempotencyKey);
        let loyaltyTransactionId: string | undefined;
        const ownershipId = randomUUID();
        if (pointsCost > 0) {
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
            throw new BadRequestException('Member balance exceeds supported point precision');
          const available = balance ? Number(balance.confirmedBalance) - Number(balance.pendingRedemption) : 0;
          if (!balance || available < pointsCost) throw new BadRequestException('Insufficient points');
          // The ownership lock can wait on another balance writer. Recheck expiry after waiting.
          if (voucher.expiresAt && voucher.expiresAt.getTime() <= Date.now())
            throw new BadRequestException('Voucher has expired');
          const [transaction] = await tx
            .insert(loyaltyTransactions)
            .values({
              organizationId,
              organizationEndUserId: memberId,
              transactionType: 'REDEEM',
              pointsAmount: pointsCost,
              idempotencyKey,
              receiptReference: `voucher-claim-${ownershipId}`,
              status: 'PENDING',
              metadata: { voucherId, voucherOwnershipId: ownershipId },
            })
            .returning();
          loyaltyTransactionId = transaction.id;
          if (!balance.suiCreditAccountId) throw new BadRequestException('Member has no on-chain CreditAccount yet');
          await tx
            .update(creditOwnerships)
            .set({
              pendingRedemption: Number(balance.pendingRedemption) + pointsCost,
              updatedAt: now,
            })
            .where(eq(creditOwnerships.id, balance.id));
        }
        const [ownership] = await tx
          .insert(voucherOwnerships)
          .values({
            id: ownershipId,
            voucherId,
            organizationEndUserId: memberId,
            status: pointsCost > 0 ? 'RESERVED' : 'AVAILABLE',
            serialCode: `${voucher.code.toUpperCase()}-${randomBytes(8).toString('hex').toUpperCase()}`,
            loyaltyTransactionId,
            expiresAt: voucher.expiresAt,
          })
          .returning();
        const claimedCount = voucher.claimedCount + 1;
        await tx
          .update(vouchers)
          .set({
            claimedCount,
            status: voucher.totalSupply !== null && claimedCount >= voucher.totalSupply ? 'DEPLETED' : 'ACTIVE',
            updatedAt: now,
          })
          .where(eq(vouchers.id, voucherId));
        const result: ClaimVoucherResponse = {
          voucherOwnershipId: ownership.id,
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
            commandType: pointsCost > 0 ? 'CREDIT_POS_REDEEM_RESERVE' : 'VOUCHER_CLAIM',
            status: pointsCost > 0 ? 'PENDING' : 'COMPLETED',
            payload: {
              voucherId,
              memberId,
              organizationEndUserId: memberId,
              pointsAmount: pointsCost,
              voucherOwnershipId: ownershipId,
              result,
            },
            updatedAt: now,
          })
          .where(eq(operations.id, operation.id));
        return result;
      });
    } catch (error) {
      if (error instanceof OperationPayloadConflictError) throw new ConflictException(error.message);
      const pgError = error as { code?: string; cause?: { code?: string } };
      if (pgError?.code === '23505' || pgError?.cause?.code === '23505') {
        throw new ConflictException('Claim conflicts with an existing operation or voucher ownership');
      }
      throw error;
    }
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
    if (!row) throw new NotFoundException('Voucher claim not found');
    const o = row.ownership;
    return {
      voucherOwnershipId: o.id,
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
      if (!found) throw new NotFoundException('Voucher serial not found');
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, found.voucherId), eq(vouchers.organizationId, organizationId)))
        .for('share');
      if (!voucher) throw new NotFoundException('Voucher serial not found');
      await this.requireActiveMember(tx, organizationId, found.organizationEndUserId);
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, found.id))
        .for('update');
      if (ownership.status !== 'AVAILABLE')
        throw new BadRequestException(`Voucher cannot be used; status is currently ${ownership.status}`);
      if (ownership.expiresAt && ownership.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('Voucher has expired');
      // Pausing stops new claims; issued vouchers retain their promised benefit and expiry.
      const [updated] = await tx
        .update(voucherOwnerships)
        .set({ status: 'REDEEMED', redeemedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(voucherOwnerships.id, ownership.id), eq(voucherOwnerships.status, 'AVAILABLE')))
        .returning();
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
