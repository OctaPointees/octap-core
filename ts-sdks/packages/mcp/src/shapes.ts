import type { CreditBalanceSnapshot, LoyaltyTransactionDto, VoucherOwnershipDto } from '@octap/sdk';
import * as z from 'zod/v4';
import { nullableAmount, nullableString, orNull } from './tool-kit.js';

/**
 * The member-level answers shared by several tools, built from whitelisted fields. A field Core
 * leaves out is `null`, so the answer always matches its schema.
 */

export const BALANCE = z.object({
  memberId: z.string(),
  confirmedBalance: nullableAmount.describe('Spendable points'),
  pendingEarn: nullableAmount.describe('Earns still in flight'),
  pendingRedemption: nullableAmount.describe('Points held for redemptions in flight'),
  lifetimeEarned: nullableAmount,
  lifetimeRedeemed: nullableAmount,
  asOfCheckpoint: nullableString,
  observedAt: nullableString,
  stale: z.boolean().nullable().describe('True when the chain could not be read and this is the last known value'),
});

export function balanceOf(balance: Partial<CreditBalanceSnapshot>, memberId: string): z.infer<typeof BALANCE> {
  return {
    memberId: balance.organizationEndUserId ?? memberId,
    confirmedBalance: orNull(balance.confirmedBalance),
    pendingEarn: orNull(balance.pendingEarn),
    pendingRedemption: orNull(balance.pendingRedemption),
    lifetimeEarned: orNull(balance.lifetimeEarned),
    lifetimeRedeemed: orNull(balance.lifetimeRedeemed),
    asOfCheckpoint: orNull(balance.asOfCheckpoint),
    observedAt: orNull(balance.observedAt),
    stale: orNull(balance.stale),
  };
}

export const TRANSACTION = z.object({
  transactionId: z.string(),
  type: nullableString.describe('EARN, REDEEM, REVERSAL, …'),
  status: nullableString.describe('PENDING until the chain confirms it, then CONFIRMED, or FAILED'),
  pointsAmount: nullableAmount.describe('Null while pending'),
  estimatedPoints: nullableAmount,
  purchaseAmount: nullableAmount,
  blockchainDigest: nullableString,
  createdAt: nullableString,
  updatedAt: nullableString,
});

export function transactionOf(tx: Partial<LoyaltyTransactionDto> & { id: string }): z.infer<typeof TRANSACTION> {
  return {
    transactionId: tx.id,
    type: orNull(tx.transactionType),
    status: orNull(tx.status),
    pointsAmount: orNull(tx.pointsAmount),
    estimatedPoints: orNull(tx.estimatedPoints),
    purchaseAmount: orNull(tx.purchaseAmount),
    blockchainDigest: orNull(tx.blockchainDigest),
    createdAt: orNull(tx.createdAt),
    updatedAt: orNull(tx.updatedAt),
  };
}

/** A voucher a member holds. The serial code is never included: it is what a cashier redeems. */
export const OWNERSHIP = z.object({
  ownershipId: z.string(),
  voucherId: nullableString,
  title: nullableString,
  status: nullableString,
  claimedAt: nullableString,
  redeemedAt: nullableString,
  expiresAt: nullableString,
});

export function ownershipOf(row: Partial<VoucherOwnershipDto> & { id: string }): z.infer<typeof OWNERSHIP> {
  return {
    ownershipId: row.id,
    voucherId: orNull(row.voucherId),
    title: orNull(row.voucher?.title),
    status: orNull(row.status),
    claimedAt: orNull(row.claimedAt),
    redeemedAt: orNull(row.redeemedAt),
    expiresAt: orNull(row.expiresAt),
  };
}
