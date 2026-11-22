import type {
  CreateVoucherRequest,
  UpdateVoucherRequest,
  GrantVoucherRequest,
  PrepareVoucherUseRequest,
  FinalizeVoucherUseRequest,
  CreateVoucherBatchRequest,
} from '@octap/contracts';

export type CreateVoucherBodyDto = CreateVoucherRequest;
export type UpdateVoucherBodyDto = UpdateVoucherRequest;

export interface ClaimVoucherBodyDto {
  organizationEndUserId: string;
  idempotencyKey: string;
}

export type GrantVoucherBodyDto = GrantVoucherRequest;
export type PrepareVoucherUseBodyDto = PrepareVoucherUseRequest;
export type FinalizeVoucherUseBodyDto = FinalizeVoucherUseRequest;

export type CreateVoucherBatchBodyDto = CreateVoucherBatchRequest;
