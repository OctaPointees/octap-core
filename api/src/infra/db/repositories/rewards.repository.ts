import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';

@Injectable()
export class RewardsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async createVoucher(data: {
    organizationId: string;
    code: string;
    title: string;
    description?: string;
    pointsCost?: number;
    discountType: string;
    discountValue?: string;
    totalSupply?: number;
    startsAt?: Date;
    expiresAt?: Date;
    metadata?: Record<string, unknown>;
  }) {
    const [voucher] = await this.db
      .insert(vouchers)
      .values({
        organizationId: data.organizationId,
        code: data.code,
        title: data.title,
        description: data.description,
        pointsCost: data.pointsCost ?? 0,
        discountType: data.discountType,
        discountValue: data.discountValue,
        totalSupply: data.totalSupply,
        claimedCount: 0,
        status: 'ACTIVE',
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        metadata: data.metadata ?? {},
      })
      .returning();

    return voucher;
  }

  async findVoucherById(id: string) {
    return this.db.query.vouchers.findFirst({
      where: eq(vouchers.id, id),
    });
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

  async claimVoucherInstance(params: {
    voucherId: string;
    organizationEndUserId: string;
    serialCode: string;
    loyaltyTransactionId?: string;
    expiresAt?: Date;
  }) {
    return this.db.transaction(async (tx) => {
      const voucher = await tx.query.vouchers.findFirst({
        where: eq(vouchers.id, params.voucherId),
      });

      if (!voucher) {
        throw new Error('Voucher not found');
      }

      if (voucher.status !== 'ACTIVE') {
        throw new Error(`Voucher is not active (current status: ${voucher.status})`);
      }

      if (
        voucher.totalSupply !== null &&
        voucher.totalSupply !== undefined &&
        voucher.claimedCount >= voucher.totalSupply
      ) {
        throw new Error('Voucher is completely depleted');
      }

      // Check if user already claimed this voucher
      const existingOwnership = await tx.query.voucherOwnerships.findFirst({
        where: and(
          eq(voucherOwnerships.voucherId, params.voucherId),
          eq(voucherOwnerships.organizationEndUserId, params.organizationEndUserId),
        ),
      });

      if (existingOwnership) {
        throw new Error('Voucher has already been claimed by this member');
      }

      const [ownership] = await tx
        .insert(voucherOwnerships)
        .values({
          voucherId: params.voucherId,
          organizationEndUserId: params.organizationEndUserId,
          serialCode: params.serialCode,
          loyaltyTransactionId: params.loyaltyTransactionId,
          status: 'AVAILABLE',
          expiresAt: params.expiresAt ?? voucher.expiresAt,
        })
        .returning();

      const newClaimedCount = voucher.claimedCount + 1;
      const isDepleted =
        voucher.totalSupply !== null && voucher.totalSupply !== undefined && newClaimedCount >= voucher.totalSupply;

      await tx
        .update(vouchers)
        .set({
          claimedCount: newClaimedCount,
          status: isDepleted ? 'DEPLETED' : voucher.status,
          updatedAt: new Date(),
        })
        .where(eq(vouchers.id, voucher.id));

      return {
        ownership,
        voucher,
      };
    });
  }

  async findOwnershipBySerial(serialCode: string) {
    return this.db.query.voucherOwnerships.findFirst({
      where: eq(voucherOwnerships.serialCode, serialCode),
      with: {
        voucher: true,
      },
    });
  }

  /** Undefined if the instance was no longer AVAILABLE (e.g. a concurrent redeem won). */
  async markVoucherRedeemed(ownershipId: string) {
    const [updated] = await this.db
      .update(voucherOwnerships)
      .set({
        status: 'REDEEMED',
        redeemedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(voucherOwnerships.id, ownershipId), eq(voucherOwnerships.status, 'AVAILABLE')))
      .returning();

    return updated;
  }

  async listOwnershipsByMember(organizationEndUserId: string) {
    return this.db.query.voucherOwnerships.findMany({
      where: eq(voucherOwnerships.organizationEndUserId, organizationEndUserId),
      with: {
        voucher: true,
      },
      orderBy: [desc(voucherOwnerships.claimedAt)],
    });
  }
}
