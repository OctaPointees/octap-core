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
  packageId: '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23',
};

/** Not deployed yet; see contracts/sui/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_PACKAGE_CONFIG: OctapPackageConfig | undefined = undefined;
