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
  packageId: '0xcad75786a5bd6b2157fcbed5bb81c819f1224111fa3f8c599e904ce7b55c041e',
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig | undefined = undefined;
