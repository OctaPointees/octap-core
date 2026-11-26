/**
 * The `octap_audit` package per network: the only ids the verifier trusts. A bundle names the
 * network its seal is on, never which package to believe. Keep in sync with
 * `contracts/audit/DEPLOYMENTS.md` by hand.
 */
export interface AuditNetworkConfig {
  /** The immutable `octap_audit` package. A real seal's type is `<packageId>::evidence_seal::EvidenceSeal`. */
  packageId: string;
  /** The shared `evidence_seal::SealRegistry`. */
  registryId: string;
  /** Sui fullnode gRPC URL. */
  rpcUrl: string;
}

export type AuditNetwork = 'testnet' | 'mainnet';

export const AUDIT_NETWORKS: Record<AuditNetwork, AuditNetworkConfig | undefined> = {
  testnet: {
    packageId: '0xe72b14575bfabc48732c0cda1e5eef7d2ebfa0a81481b5fd1cd8547edfb74b84',
    registryId: '0x23615d46f0727903f35b096a63ea02fa7cfa050c76742a37fddb307a7cdc8807',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
  },
  /** Not published yet; see contracts/audit/DEPLOYMENTS.md. */
  mainnet: undefined,
};

export function auditNetwork(network: string): AuditNetworkConfig {
  const config = (AUDIT_NETWORKS as Record<string, AuditNetworkConfig | undefined>)[network];
  if (!config) throw new Error(`No octap_audit package is published on Sui network "${network}"`);
  return config;
}

/** The Suiscan page of a transaction, for people. */
export function suiscanTransactionUrl(network: string, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
