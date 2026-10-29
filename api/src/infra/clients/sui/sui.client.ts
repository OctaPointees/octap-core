import { Injectable, Logger } from '@nestjs/common';
import {
  OctapChainClient,
  eventField,
  operationShardIndex,
  TESTNET_OCTAP_PACKAGE_CONFIG,
  MAINNET_OCTAP_PACKAGE_CONFIG,
  type OctapNetwork,
  type OctapProgramConfig,
  type SignedChainTransaction,
  type SubmittedChainTransaction,
} from '@octap/chain';
import { configForNetwork } from './network-config.js';
import { ISSUER_SIGNER, loadSigner, memoizeSigner } from './signer.js';

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
 * to reach the issuer signer at all, only the worker process that actually dispatches chain
 * transactions does. The signer is the AWS KMS key in `SUI_ISSUER_KMS_KEY_ID` (or, off mainnet,
 * the raw `SUI_ISSUER_PRIVATE_KEY`) — see `signer.ts`.
 *
 * Program-agnostic: every call takes the calling organization's `OctapProgramConfig`, resolved
 * from its `programs` row by `domain/programs`' `resolveProgramConfig`. Only the package id is
 * global (one published `octap` package per network).
 */
@Injectable()
export class SuiClientService {
  private readonly logger = new Logger(SuiClientService.name);
  private readonly network: OctapNetwork = (process.env.SUI_NETWORK as OctapNetwork | undefined) ?? 'testnet';
  private chainClient?: OctapChainClient;
  private readonly issuerSigner = memoizeSigner(() => loadSigner(ISSUER_SIGNER, this.network, this.logger));

  private get client(): OctapChainClient {
    if (!this.chainClient) {
      const pkg = configForNetwork(
        this.network,
        { testnet: TESTNET_OCTAP_PACKAGE_CONFIG, mainnet: MAINNET_OCTAP_PACKAGE_CONFIG },
        'octap package',
      );
      this.chainClient = new OctapChainClient({ network: this.network, package: pkg });
    }
    return this.chainClient;
  }

  /** The address every call in this service signs with — for stamping `blockchainTransactions.sender`. */
  async issuerAddress(): Promise<string> {
    return (await this.issuerSigner()).toSuiAddress();
  }

  async openAccount(program: OctapProgramConfig, beneficiary: string): Promise<ChainCallResult> {
    const tx = this.client.buildOpenAccountTransaction({
      issuerCapId: program.issuerCapId,
      programId: program.programControlId,
      beneficiary,
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`opening credit account for ${beneficiary} in program ${program.programControlId}`);
    return toChainCallResult(await this.client.signAndExecute(tx, await this.issuerSigner()));
  }

  /**
   * Builds and signs an `earn` without sending it, so the caller can persist `digest` first and
   * resolve an outcome-unknown `execute` by digest later (OCT-52). Throwing here is definitive:
   * nothing was sent.
   */
  async signEarn(
    program: OctapProgramConfig,
    params: { accountId: string; purchaseAmount: number; operationKey: string },
  ): Promise<SignedChainTransaction> {
    const operationKey = new TextEncoder().encode(params.operationKey);
    const { operationShardId, budgetShardId } = selectShards(program, operationKey);
    const tx = this.client.buildEarnTransaction({
      issuerCapId: program.issuerCapId,
      programId: program.programControlId,
      policyId: program.policyVersionId,
      accountId: params.accountId,
      operationShardId,
      budgetShardId,
      purchaseAmount: params.purchaseAmount,
      operationKey,
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(
      `earn ${params.purchaseAmount} purchase units -> account ${params.accountId} in program ${program.programControlId}`,
    );
    return this.client.sign(tx, await this.issuerSigner());
  }

  /**
   * Builds and signs a `reverse_earn` of the earn recorded under `operationKey`, without sending
   * it (same digest-first contract as `signEarn`). Routed to the shard pair that owns the key — the
   * one the earn itself was recorded in and debited from.
   */
  async signReverseEarn(
    program: OctapProgramConfig,
    params: { accountId: string; operationKey: string },
  ): Promise<SignedChainTransaction> {
    const operationKey = new TextEncoder().encode(params.operationKey);
    const { operationShardId, budgetShardId } = selectShards(program, operationKey);
    const tx = this.client.buildReverseEarnTransaction({
      issuerCapId: program.issuerCapId,
      accountId: params.accountId,
      operationShardId,
      budgetShardId,
      operationKey,
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`reverse earn ${params.operationKey} on account ${params.accountId}`);
    return this.client.sign(tx, await this.issuerSigner());
  }

  /** Builds and signs a `reverse_redeem` of the redemption named `reference`, without sending it. */
  async signReverseRedeem(
    program: OctapProgramConfig,
    params: { accountId: string; reference: string },
  ): Promise<SignedChainTransaction> {
    const tx = this.client.buildReverseRedeemTransaction({
      issuerCapId: program.issuerCapId,
      accountId: params.accountId,
      reference: new TextEncoder().encode(params.reference),
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`reverse redeem ${params.reference} on account ${params.accountId}`);
    return this.client.sign(tx, await this.issuerSigner());
  }

  /** Read-only: the program a `CreditAccount` was opened in, or null if the object doesn't exist. */
  async creditAccountProgramId(accountId: string): Promise<string | null> {
    return this.client.creditAccountProgramId(accountId);
  }

  /** Sends a transaction from a `sign*` method. Throwing here means the outcome is unknown, not failed. */
  async execute(signed: SignedChainTransaction): Promise<ChainCallResult> {
    this.logger.log(`executing ${signed.digest}`);
    return toChainCallResult(await this.client.executeSigned(signed));
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

/**
 * The operation/budget shard pair that owns `operationKey`. Both share one index by design (see
 * `budget_shard.move`), so a program's two shard lists must be the same non-zero length.
 */
export function selectShards(
  config: Pick<OctapProgramConfig, 'operationShardIds' | 'budgetShardIds'>,
  operationKey: Uint8Array,
): { operationShardId: string; budgetShardId: string } {
  const shardCount = config.operationShardIds.length;
  if (shardCount === 0 || config.budgetShardIds.length !== shardCount) {
    throw new Error(
      `Sui chain adapter: program has ${shardCount} operation shard(s) and ${config.budgetShardIds.length} budget shard(s); expected the same non-zero count`,
    );
  }
  const index = operationShardIndex(operationKey, shardCount);
  return { operationShardId: config.operationShardIds[index], budgetShardId: config.budgetShardIds[index] };
}
