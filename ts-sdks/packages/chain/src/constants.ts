/**
 * Network-keyed object ids for the deployed `octap` Move package. Keep this
 * in sync with `contracts/sui/DEPLOYMENTS.md` by hand — there is no registry
 * or indexer to read it from yet.
 */
export interface OctapPackageConfig {
  /** Current (possibly upgraded) package id. Used as the moveCall target. */
  packageId: string;
}

export const TESTNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig = {
  packageId: '0xda317c683fd6cbabc25d03f04c5aa27711cf3c5ffe4e3ef79c154174da7c3a60',
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig | undefined = undefined;

/**
 * The single demo `ProgramControl` this codebase dispatches every organization's earn against
 * today — see `docs/roadmap.md`'s `domain/programs` row for the real per-organization mapping
 * this will need before production use. These are public on-chain object ids, not secrets: safe
 * to commit, same as `TESTNET_OCTAP_PACKAGE_CONFIG`. Keep in sync with
 * `contracts/sui/DEPLOYMENTS.md` by hand.
 */
export interface OctapDemoProgramConfig extends OctapPackageConfig {
  /** Shared `octap::program_control::ProgramControl` object id. */
  programControlId: string;
  /** Immutable `octap::policy_version::PolicyVersion` currently activated for this program. */
  policyVersionId: string;
  /** `octap::capabilities::IssuerCap` authorizing `earn` for this program. */
  issuerCapId: string;
  /**
   * Shared `octap::operation_shard::OperationShard` ids, in shard-index order. `earn` must be
   * given `operationShardIds[operationShardIndex(key, operationShardIds.length)]`.
   */
  operationShardIds: readonly string[];
  /** Shared `octap::budget_shard::BudgetShard` ids, in shard-index order; same length as above. */
  budgetShardIds: readonly string[];
}

export const TESTNET_OCTAP_DEMO_PROGRAM_CONFIG: OctapDemoProgramConfig = {
  packageId: TESTNET_OCTAP_PACKAGE_CONFIG.packageId,
  programControlId: '0x899991c6ead71097af4c32b127678db511fa18e2070c3f7b5735dfc593ee82f2',
  policyVersionId: '0xaba658afa214b9c236e6c32083d3c195899df27b105a6ada7c5349a39ee0eb6a',
  issuerCapId: '0xf873b25be6a95790a70190e393e4facfb0885a037f69e644cb0861bcd629ceb3',
  operationShardIds: ['0xd59a9b57e8c80d7fd98876c1a3b37aa823e0e3e11c265d4004b30e4bb486ee85'],
  budgetShardIds: ['0x7544cb71e0359c11be7c70a688f1fd5855ba126f5e0b5106a1509ce4d3bab833'],
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_DEMO_PROGRAM_CONFIG: OctapDemoProgramConfig | undefined = undefined;
