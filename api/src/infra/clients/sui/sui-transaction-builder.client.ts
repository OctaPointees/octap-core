import { Injectable } from '@nestjs/common';
import {
  OctapChainClient,
  TESTNET_OCTAP_PACKAGE_CONFIG,
  MAINNET_OCTAP_PACKAGE_CONFIG,
  type OctapNetwork,
  type OctapPackageConfig,
  type SubmittedChainTransaction,
  type CreditAccountEventPage,
} from '@octap/chain';

function packageConfig(network: OctapNetwork): OctapPackageConfig {
  if (network === 'testnet') {
    return TESTNET_OCTAP_PACKAGE_CONFIG;
  }
  if (network === 'mainnet' && MAINNET_OCTAP_PACKAGE_CONFIG) {
    return MAINNET_OCTAP_PACKAGE_CONFIG;
  }
  throw new Error(`Sui transaction builder: no package configured for network "${network}"`);
}

/**
 * HTTP-process-safe counterpart to `SuiClientService`: builds unsigned transaction *kind* bytes
 * only. There is no signer anywhere in this class and it never reads `SUI_ISSUER_PRIVATE_KEY`,
 * so — unlike `infra/clients/sui/sui.module.ts` — it's safe to register in
 * `infra/infrastructure.module.ts` and reach from `AppModule`. See `sui.client.ts`'s `redeem()`
 * doc comment for why building the redeem transaction kind lives here instead of there: it's an
 * HTTP-request-shaped capability (the end user signs it), not a worker job.
 */
@Injectable()
export class SuiTransactionBuilderClient {
  private readonly network: OctapNetwork = (process.env.SUI_NETWORK as OctapNetwork | undefined) ?? 'testnet';
  private readonly packageId = packageConfig(this.network).packageId;
  private chainClient?: OctapChainClient;

  private get client(): OctapChainClient {
    if (!this.chainClient) {
      this.chainClient = new OctapChainClient({ network: this.network, package: { packageId: this.packageId } });
    }
    return this.chainClient;
  }

  /** The only Move call this class's redeem builder can ever produce — for sponsorship allowlists. */
  get redeemMoveCallTarget(): string {
    return `${this.packageId}::credit_account::redeem`;
  }

  /** The only Move call `buildClaimVoucherTransactionKind` can produce. */
  get claimVoucherMoveCallTarget(): string {
    return `${this.packageId}::credit_account::claim_voucher`;
  }

  /** The only Move call `buildUseVoucherTransactionKind` can produce. */
  get useVoucherMoveCallTarget(): string {
    return `${this.packageId}::credit_account::use_voucher`;
  }

  /** Builds `credit_account::claim_voucher`'s transaction kind. The price comes from the terms. */
  async buildClaimVoucherTransactionKind(params: {
    accountId: string;
    termsId: string;
    reference: Uint8Array;
  }): Promise<Uint8Array> {
    const tx = this.client.buildClaimVoucherTransaction(params);
    return tx.build({ client: this.client.rpc, onlyTransactionKind: true });
  }

  /** Builds `credit_account::use_voucher`'s transaction kind. */
  async buildUseVoucherTransactionKind(params: {
    accountId: string;
    termsId: string;
    reference: Uint8Array;
  }): Promise<Uint8Array> {
    const tx = this.client.buildUseVoucherTransaction(params);
    return tx.build({ client: this.client.rpc, onlyTransactionKind: true });
  }

  /** Builds `credit_account::redeem`'s transaction kind: no sender, no gas, nothing signed yet. */
  async buildRedeemTransactionKind(params: {
    accountId: string;
    cost: bigint;
    reference: Uint8Array;
  }): Promise<Uint8Array> {
    const tx = this.client.buildRedeemTransaction(params);
    return tx.build({ client: this.client.rpc, onlyTransactionKind: true });
  }

  /**
   * Reads back a transaction this process never signed — e.g. one Enoki executed on the
   * beneficiary's behalf after `previewSponsoredRedeem` — so the caller can confirm it landed
   * and read its events. No signer involved; safe here for the same reason the rest of this
   * class is.
   */
  async waitForTransaction(digest: string): Promise<SubmittedChainTransaction> {
    return this.client.waitForTransaction(digest);
  }

  /** A budget shard's remaining points. No signer involved. */
  async budgetShardRemaining(shardId: string): Promise<bigint> {
    return this.client.budgetShardRemaining(shardId);
  }

  /** One lookup by digest, no polling; null if the chain has no such transaction. Read-only. */
  async findTransaction(digest: string): Promise<SubmittedChainTransaction | null> {
    return this.client.findTransaction(digest);
  }

  async currentEpoch(): Promise<bigint> {
    return this.client.currentEpoch();
  }

  /** Read-only event stream for `domain/indexer` — no signer, same reasoning as the rest of this class. */
  async listCreditAccountEvents(options: {
    after?: string | null;
    limit?: number;
    order?: 'ascending' | 'descending';
  }): Promise<CreditAccountEventPage> {
    return this.client.listCreditAccountEvents(options);
  }
}
