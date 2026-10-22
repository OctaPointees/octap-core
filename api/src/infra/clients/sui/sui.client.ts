import { Injectable, Logger } from '@nestjs/common';
import {
  OctapChainClient,
  eventField,
  signerFromPrivateKey,
  TESTNET_OCTAP_DEMO_PROGRAM_CONFIG,
  MAINNET_OCTAP_DEMO_PROGRAM_CONFIG,
  type OctapNetwork,
  type SubmittedChainTransaction,
} from '@octap/chain';
import type { Signer } from '@mysten/sui/cryptography';
import { requireEnv } from '../require-env.js';
import { configForNetwork } from './network-config.js';

export interface ChainCallResult extends SubmittedChainTransaction {
  /** Convenience lookup: the first value of `field` on any event named `::<eventSuffix>`. */
  eventField<T = unknown>(eventSuffix: string, field: string): T | undefined;
}

function toChainCallResult(result: SubmittedChainTransaction): ChainCallResult {
  return {
    ...result,
    eventField: (eventSuffix, field) => eventField(result, eventSuffix, field) as never,
  };
}

/**
 * Worker-only adapter to `@octap/chain`. Registered in `worker.module.ts`, never in
 * `infra/infrastructure.module.ts` — `AppModule` (the internet-facing HTTP process) has no reason
 * to hold `SUI_ISSUER_PRIVATE_KEY` in memory at all, only the worker process that actually
 * dispatches chain transactions does.
 *
 * Demo-scoped: one program/policy/IssuerCap (from `@octap/chain`'s committed constants, keyed
 * only by `SUI_NETWORK`), applied to every organization, until `domain/programs`
 * (docs/roadmap.md) exists to look these up per organization instead.
 */
@Injectable()
export class SuiClientService {
  private readonly logger = new Logger(SuiClientService.name);
  private readonly network: OctapNetwork = (process.env.SUI_NETWORK as OctapNetwork | undefined) ?? 'testnet';
  private readonly programConfig = configForNetwork(
    this.network,
    { testnet: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG, mainnet: MAINNET_OCTAP_DEMO_PROGRAM_CONFIG },
    'demo program',
  );
  private chainClient?: OctapChainClient;
  private signer?: Signer;

  private get client(): OctapChainClient {
    if (!this.chainClient) {
      this.chainClient = new OctapChainClient({ network: this.network, package: this.programConfig });
    }
    return this.chainClient;
  }

  private get issuerSigner(): Signer {
    if (!this.signer) {
      this.signer = signerFromPrivateKey(requireEnv('SUI_ISSUER_PRIVATE_KEY', 'Sui chain adapter'));
    }
    return this.signer;
  }

  /** The address every call in this service signs with — for stamping `blockchainTransactions.sender`. */
  issuerAddress(): string {
    return this.issuerSigner.getPublicKey().toSuiAddress();
  }

  async openAccount(beneficiary: string): Promise<ChainCallResult> {
    const tx = this.client.buildOpenAccountTransaction({
      issuerCapId: this.programConfig.issuerCapId,
      programId: this.programConfig.programControlId,
      beneficiary,
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`opening credit account for ${beneficiary}`);
    return toChainCallResult(await this.client.signAndExecute(tx, this.issuerSigner));
  }

  async earn(params: { accountId: string; purchaseAmount: number; operationKey: string }): Promise<ChainCallResult> {
    const tx = this.client.buildEarnTransaction({
      issuerCapId: this.programConfig.issuerCapId,
      programId: this.programConfig.programControlId,
      policyId: this.programConfig.policyVersionId,
      accountId: params.accountId,
      purchaseAmount: params.purchaseAmount,
      operationKey: new TextEncoder().encode(params.operationKey),
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`earn ${params.purchaseAmount} purchase units -> account ${params.accountId}`);
    return toChainCallResult(await this.client.signAndExecute(tx, this.issuerSigner));
  }

  // No `redeem()` wrapper here, deliberately: `credit_account::redeem` requires
  // `sender == beneficiary` (contracts/sui/credit_account.move), and this service only ever signs
  // with the IssuerCap holder's key. A worker calling redeem would abort on-chain with
  // `ENotBeneficiary` every single time — not an edge case to handle, a guarantee the beneficiary
  // consent invariant is actually enforced. Submitting a redeem needs the end user's own
  // signature (zkLogin — docs/roadmap.md "Identity", not started), which means building the
  // unsigned transaction via `OctapChainClient.buildRedeemTransaction` for the client to sign is
  // an HTTP-request-shaped feature, not a worker job; add it there once zkLogin exists instead of
  // routing it through this service.
}
