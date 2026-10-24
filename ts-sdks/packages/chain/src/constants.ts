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
  packageId: '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b',
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig | undefined = undefined;
