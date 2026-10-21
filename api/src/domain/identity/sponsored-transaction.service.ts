import { Injectable } from '@nestjs/common';
import { EnokiClient } from '../../infra/clients/enoki/enoki.client.js';
import { SuiTransactionBuilderClient } from '../../infra/clients/sui/sui-transaction-builder.client.js';

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
 * Deliberately stops at "preview": executing the signed result and updating the PostgreSQL
 * ownership/balance rows is OCT-55's remaining scope (docs/roadmap.md), which calls this service
 * rather than duplicating it.
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
}
