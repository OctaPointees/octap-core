import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { AUDIT_NETWORKS, type AuditNetworkConfig } from '@octap/verify';

/**
 * The `octap_audit` package (OCT-77): the ids `@octap/verify` trusts, plus the `SealerCap` only the
 * sealing signer uses. See `contracts/audit/DEPLOYMENTS.md`.
 */
export interface OctapAuditConfig extends AuditNetworkConfig {
  /** `evidence_seal::SealerCap`, owned by the issuer address. */
  sealerCapId: string;
}

export const TESTNET_OCTAP_AUDIT_CONFIG: OctapAuditConfig = {
  ...AUDIT_NETWORKS.testnet!,
  sealerCapId: '0xac58eb84562fc7ffd110e06d7b94f76b97ee518e04ac7e5b89997d90d7f2cad4',
};

/** Not published yet; see contracts/audit/DEPLOYMENTS.md. */
export const MAINNET_OCTAP_AUDIT_CONFIG: OctapAuditConfig | undefined = undefined;

export interface SealEvidenceParams {
  organizationId: string;
  periodStartMs: number;
  periodEndMs: number;
  /** Hex sha256 of the period's manifest. */
  manifestHash: string;
  /** The organization's latest seal's manifest hash, null on its first. */
  previousManifestHash: string | null;
}

function hexBytes(hex: string | null): number[] {
  if (!hex) return [];
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Not a sha256 hex digest: ${hex}`);
  return Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** `evidence_seal::seal`, signed by the `SealerCap` holder. */
export function buildSealEvidenceTransaction(config: OctapAuditConfig, params: SealEvidenceParams): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::evidence_seal::seal`,
    arguments: [
      tx.object(config.sealerCapId),
      tx.object(config.registryId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(params.organizationId))),
      tx.pure.u64(params.periodStartMs),
      tx.pure.u64(params.periodEndMs),
      tx.pure.vector('u8', hexBytes(params.manifestHash)),
      tx.pure.vector('u8', hexBytes(params.previousManifestHash)),
      tx.object.clock(),
    ],
  });
  return tx;
}

/**
 * The organization's latest seal id, from the registry itself (a simulated call, nothing signed),
 * or null before its first. Lets the worker tell whether a seal it may have sent already landed.
 */
export async function latestEvidenceSealId(
  client: SuiGrpcClient,
  config: AuditNetworkConfig,
  organizationId: string,
): Promise<string | null> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress('0x0'));
  tx.moveCall({
    target: `${config.packageId}::evidence_seal::latest_seal_id`,
    arguments: [
      tx.object(config.registryId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(organizationId))),
    ],
  });
  const result = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  const value = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (result.$kind !== 'Transaction' || !value) throw new Error('evidence_seal::latest_seal_id could not be read');
  const id = bcs.option(bcs.Address).parse(value);
  return id ? normalizeSuiAddress(id) : null;
}
