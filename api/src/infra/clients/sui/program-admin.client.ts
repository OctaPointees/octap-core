import { Injectable, Logger } from '@nestjs/common';
import {
  OctapChainClient,
  eventField,
  signerFromPrivateKey,
  TESTNET_OCTAP_PACKAGE_CONFIG,
  MAINNET_OCTAP_PACKAGE_CONFIG,
  type OctapNetwork,
  type SubmittedChainTransaction,
} from '@octap/chain';
import type { Signer } from '@mysten/sui/cryptography';
import { requireEnv } from '../require-env.js';
import { configForNetwork } from './network-config.js';

export interface ProvisionedProgram {
  programId: string;
  adminCapId: string;
  policyVersionId: string;
  issuerCapId: string;
  /** `OperationShard` ids in shard-index order. */
  operationShardIds: string[];
  /** `BudgetShard` ids in shard-index order; same length as `operationShardIds`. */
  budgetShardIds: string[];
}

/** Every `<eventSuffix>` event's `shard_id`, ordered by its `shard_index`. */
function shardIdsByIndex(result: SubmittedChainTransaction, eventSuffix: string): string[] {
  return result.events
    .filter((e) => e.type.endsWith(`::${eventSuffix}`))
    .map((e) => e.parsedJson as { shard_id: string; shard_index: string })
    .sort((a, b) => Number(a.shard_index) - Number(b.shard_index))
    .map((e) => e.shard_id);
}

/**
 * Worker-only: mints a new on-chain program (`ProgramControl` + `AdminCap`), publishes and
 * activates its policy, issues an `IssuerCap` to `issuerRecipient`, and creates its operation and
 * budget shards — a one-time
 * provisioning action per organization, not a per-request chain call (see `domain/programs`).
 *
 * Holds `SUI_PROGRAM_ADMIN_PRIVATE_KEY`, deliberately a different key from
 * `SUI_ISSUER_PRIVATE_KEY`: an `AdminCap` can create programs, pause them, rotate policy, and
 * mint `IssuerCap`s — a much larger blast radius than the earn-only `IssuerCap` signer, so it
 * must never be the same key and must never reach the HTTP process. Registered only in
 * `worker.module.ts`, same rule as `SuiClientService`.
 */
@Injectable()
export class ProgramAdminClient {
  private readonly logger = new Logger(ProgramAdminClient.name);
  private readonly network: OctapNetwork = (process.env.SUI_NETWORK as OctapNetwork | undefined) ?? 'testnet';
  private chainClient?: OctapChainClient;
  private signer?: Signer;

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

  private get adminSigner(): Signer {
    if (!this.signer) {
      this.signer = signerFromPrivateKey(requireEnv('SUI_PROGRAM_ADMIN_PRIVATE_KEY', 'program admin adapter'));
    }
    return this.signer;
  }

  /**
   * Three sequential transactions, not one PTB: `create_program` shares its `ProgramControl`
   * and `publish` freezes its `PolicyVersion` internally, without returning either to the
   * caller, so each one's id is only knowable from *this* transaction's effects — usable as an
   * input to the *next* transaction, never within the same one. Shards ride along in the third
   * transaction rather than a fourth, and their inputs are validated before the first, so adding
   * them introduces no new point where a program can land on-chain half-provisioned.
   */
  async provisionProgram(params: {
    earnBps: number;
    expiryMs: number;
    issuerRecipient: string;
    shardCount: number;
    totalBudget: number;
  }): Promise<ProvisionedProgram> {
    if (!Number.isSafeInteger(params.shardCount) || params.shardCount < 1) {
      throw new Error(`shardCount must be a positive integer, got ${params.shardCount}`);
    }
    if (!Number.isSafeInteger(params.totalBudget) || params.totalBudget < 0) {
      throw new Error(`totalBudget must be a non-negative integer, got ${params.totalBudget}`);
    }

    const createTx = this.client.buildCreateProgramTransaction();
    createTx.setGasBudget(50_000_000);
    const created = await this.client.signAndExecute(createTx, this.adminSigner);
    if (created.status !== 'success') {
      throw new Error(created.errorMessage ?? 'create_program failed on-chain');
    }
    const programId = eventField<string>(created, 'ProgramCreated', 'program_id');
    const adminCapId = eventField<string>(created, 'ProgramCreated', 'admin_cap_id');
    if (!programId || !adminCapId) {
      throw new Error('create_program did not emit ProgramCreated');
    }
    this.logger.log(`created program ${programId}`);

    const publishTx = this.client.buildPublishPolicyTransaction({
      adminCapId,
      programId,
      version: 1,
      earnBps: params.earnBps,
      expiryMs: params.expiryMs,
    });
    publishTx.setGasBudget(50_000_000);
    const published = await this.client.signAndExecute(publishTx, this.adminSigner);
    if (published.status !== 'success') {
      throw new Error(published.errorMessage ?? 'policy_version::publish failed on-chain');
    }
    const policyVersionId = eventField<string>(published, 'PolicyPublished', 'policy_version_id');
    if (!policyVersionId) {
      throw new Error('policy_version::publish did not emit PolicyPublished');
    }
    this.logger.log(`published policy ${policyVersionId} for program ${programId}`);

    const activateTx = this.client.buildActivatePolicyAndIssueCapTransaction({
      adminCapId,
      programId,
      policyVersionId,
      issuerRecipient: params.issuerRecipient,
      shards: { shardCount: params.shardCount, totalBudget: params.totalBudget },
    });
    activateTx.setGasBudget(50_000_000);
    const activated = await this.client.signAndExecute(activateTx, this.adminSigner);
    if (activated.status !== 'success') {
      throw new Error(activated.errorMessage ?? 'activate_policy/issue_cap/create_shards failed on-chain');
    }
    const issuerCapId = eventField<string>(activated, 'IssuerCapIssued', 'issuer_cap_id');
    if (!issuerCapId) {
      throw new Error('program_control::issue_cap did not emit IssuerCapIssued');
    }
    const operationShardIds = shardIdsByIndex(activated, 'OperationShardCreated');
    const budgetShardIds = shardIdsByIndex(activated, 'BudgetShardCreated');
    if (operationShardIds.length !== params.shardCount || budgetShardIds.length !== params.shardCount) {
      throw new Error(
        `create_shards emitted ${operationShardIds.length} operation / ${budgetShardIds.length} budget shard event(s), expected ${params.shardCount} each`,
      );
    }
    this.logger.log(
      `activated policy, issued cap ${issuerCapId}, and created ${params.shardCount} shard pair(s) for program ${programId}`,
    );

    return { programId, adminCapId, policyVersionId, issuerCapId, operationShardIds, budgetShardIds };
  }
}
