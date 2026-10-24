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
  packageId: '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba',
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig | undefined = undefined;
