import type { CreateVoucherRequest, UpdateVoucherRequest } from '@octap/contracts';

export type CreateVoucherBodyDto = CreateVoucherRequest;
export type UpdateVoucherBodyDto = UpdateVoucherRequest;

export interface ClaimVoucherBodyDto {
  organizationEndUserId: string;
  idempotencyKey?: string;
}

export interface RedeemVoucherBodyDto {
  serialCode: string;
  receiptReference?: string;
}
