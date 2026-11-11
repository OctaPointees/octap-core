import type {
  ConsoleVoucherInput,
  CreateVoucherRequest,
  UpdateVoucherRequest,
  GrantVoucherRequest,
  PrepareVoucherUseRequest,
  FinalizeVoucherUseRequest,
} from '@octap/contracts';

export type CreateVoucherBodyDto = CreateVoucherRequest;
export type UpdateVoucherBodyDto = UpdateVoucherRequest;
export type ConsoleVoucherBodyDto = ConsoleVoucherInput;

export interface ClaimVoucherBodyDto {
  organizationEndUserId: string;
  idempotencyKey: string;
}

export type GrantVoucherBodyDto = GrantVoucherRequest;
export type PrepareVoucherUseBodyDto = PrepareVoucherUseRequest;
export type FinalizeVoucherUseBodyDto = FinalizeVoucherUseRequest;
