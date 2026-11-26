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
    packageId: '0xd6cf2cfc77078d64b7a4a8b2cc7facc747812a43a38fc82096f2a0a181799c6c',
    registryId: '0x117e9bdacdde8b491b51326c29d72ba2f4c756fac46eff52ab10782c95907784',
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
