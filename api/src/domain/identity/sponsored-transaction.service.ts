import { Injectable } from '@nestjs/common';
import { EnokiClient } from '#infra/clients/enoki/enoki.client.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';

export interface SponsoredRedeemPreview {
  /** Base64 full transaction bytes (kind + Enoki's gas data) for the end user to zkLogin-sign. */
  transactionBytes: string;
  /** Digest the end user's signature must correspond to when later executing it. */
  digest: string;
}

/**
 * The only place a sponsored `credit_account::redeem` transaction gets built. Callers pass typed
 * domain values — account id, cost, reference — never raw transaction bytes, and there is no
 * parameter anywhere on this class that could make it build or sponsor anything other than
 * `credit_account::redeem`: `allowedMoveCallTargets` is always exactly one hardcoded entry.
 *
 * `previewSponsoredRedeem` only builds and sponsors; `executeSponsoredRedeem` only submits a
 * signature against an already-sponsored digest. Neither touches PostgreSQL ownership/balance
 * rows — that orchestration (and the reserve/finalize lifecycle around these two calls) is
 * `domain/credits/pos-redemption.service.ts` (OCT-55), which calls both rather than duplicating
 * either.
 */
@Injectable()
export class SponsoredTransactionService {
  constructor(
    private readonly enoki: EnokiClient,
    private readonly builder: SuiTransactionBuilderClient,
  ) {}

  async previewSponsoredRedeem(params: {
    beneficiaryAddress: string;
    accountId: string;
    cost: bigint;
    reference: Uint8Array;
  }): Promise<SponsoredRedeemPreview> {
    const kindBytes = await this.builder.buildRedeemTransactionKind(params);
    const sponsored = await this.enoki.createSponsoredTransaction({
      transactionKindBytes: kindBytes,
      sender: params.beneficiaryAddress,
      allowedMoveCallTargets: [this.builder.redeemMoveCallTarget],
    });
    return { transactionBytes: sponsored.bytes, digest: sponsored.digest };
  }

  /** Sponsors a customer-signed `claim_voucher`. The price comes from the terms. */
  async previewSponsoredClaimVoucher(params: {
    beneficiaryAddress: string;
    accountId: string;
    termsId: string;
    reference: Uint8Array;
  }): Promise<SponsoredRedeemPreview> {
    const kindBytes = await this.builder.buildClaimVoucherTransactionKind(params);
    const sponsored = await this.enoki.createSponsoredTransaction({
      transactionKindBytes: kindBytes,
      sender: params.beneficiaryAddress,
      allowedMoveCallTargets: [this.builder.claimVoucherMoveCallTarget],
    });
    return { transactionBytes: sponsored.bytes, digest: sponsored.digest };
  }

  /** Sponsors a customer-signed `use_voucher`. */
  async previewSponsoredUseVoucher(params: {
    beneficiaryAddress: string;
    accountId: string;
    termsId: string;
    reference: Uint8Array;
  }): Promise<SponsoredRedeemPreview> {
    const kindBytes = await this.builder.buildUseVoucherTransactionKind(params);
    const sponsored = await this.enoki.createSponsoredTransaction({
      transactionKindBytes: kindBytes,
      sender: params.beneficiaryAddress,
      allowedMoveCallTargets: [this.builder.useVoucherMoveCallTarget],
    });
    return { transactionBytes: sponsored.bytes, digest: sponsored.digest };
  }

  /** Submits the beneficiary's signature over a digest `previewSponsoredRedeem` already sponsored. */
  async executeSponsoredRedeem(params: { digest: string; signature: string }): Promise<{ digest: string }> {
    return this.enoki.executeSponsoredTransaction(params);
  }
}
