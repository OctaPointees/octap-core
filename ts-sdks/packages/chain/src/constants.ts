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
  packageId: '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392',
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
  programControlId: '0xa00660cbaf73253db7628ab3927f3234c6058ac0afa6d1fcb620d10fcf990434',
  policyVersionId: '0x627cc1e3152b501887ab05be1f24294abae34ea4135da658da3a47ddcddf0ba6',
  issuerCapId: '0xf0896fc57c6edd4ada51fd20ea561e24cb7d962d8920ac29db6105cedf7455cc',
  // Filled in by the OCT-41 republish (shard_count = 1): the package above predates the shard
  // modules, so this program has no shards and `earn` against it can't be submitted yet.
  operationShardIds: [],
  budgetShardIds: [],
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_DEMO_PROGRAM_CONFIG: OctapDemoProgramConfig | undefined = undefined;
