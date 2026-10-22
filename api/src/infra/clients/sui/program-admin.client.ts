import { Injectable, Logger } from '@nestjs/common';
import {
  OctapChainClient,
  eventField,
  signerFromPrivateKey,
  TESTNET_OCTAP_PACKAGE_CONFIG,
  MAINNET_OCTAP_PACKAGE_CONFIG,
  type OctapNetwork,
} from '@octap/chain';
import type { Signer } from '@mysten/sui/cryptography';
import { requireEnv } from '../require-env.js';
import { configForNetwork } from './network-config.js';

export interface ProvisionedProgram {
  programId: string;
  adminCapId: string;
  policyVersionId: string;
  issuerCapId: string;
}

/**
 * Worker-only: mints a new on-chain program (`ProgramControl` + `AdminCap`), publishes and
 * activates its policy, and issues an `IssuerCap` to `issuerRecipient` — a one-time
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
   * input to the *next* transaction, never within the same one.
   */
  async provisionProgram(params: {
    earnBps: number;
    expiryMs: number;
    issuerRecipient: string;
  }): Promise<ProvisionedProgram> {
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
    });
    activateTx.setGasBudget(50_000_000);
    const activated = await this.client.signAndExecute(activateTx, this.adminSigner);
    if (activated.status !== 'success') {
      throw new Error(activated.errorMessage ?? 'activate_policy/issue_cap failed on-chain');
    }
    const issuerCapId = eventField<string>(activated, 'IssuerCapIssued', 'issuer_cap_id');
    if (!issuerCapId) {
      throw new Error('program_control::issue_cap did not emit IssuerCapIssued');
    }
    this.logger.log(`activated policy and issued cap ${issuerCapId} for program ${programId}`);

    return { programId, adminCapId, policyVersionId, issuerCapId };
  }
}
