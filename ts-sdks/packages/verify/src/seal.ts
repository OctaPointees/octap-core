import { bcs } from '@mysten/sui/bcs';
import { ObjectError } from '@mysten/sui/client';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { auditNetwork, type AuditNetwork } from './networks.js';

/** `octap_audit::evidence_seal::EvidenceSeal`, field for field. */
const EvidenceSealBcs = bcs.struct('EvidenceSeal', {
  id: bcs.Address,
  organization_id: bcs.vector(bcs.u8()),
  period_start_ms: bcs.u64(),
  period_end_ms: bcs.u64(),
  manifest_hash: bcs.vector(bcs.u8()),
  previous_manifest_hash: bcs.vector(bcs.u8()),
  sealed_at_ms: bcs.u64(),
});

/** A seal as it is on-chain. */
export interface OnChainSeal {
  sealObjectId: string;
  organizationId: string;
  periodStartMs: number;
  periodEndMs: number;
  manifestHash: string;
  /** Null on an organization's first seal. */
  previousManifestHash: string | null;
  sealedAtMs: number;
  /** The transaction that created it (a frozen object is never touched again). */
  transactionDigest: string | null;
}

/** Where to read seals from. Only the `octap_audit` package of that network is trusted. */
export interface SealReader {
  readSeal(sealObjectId: string): Promise<OnChainSeal | null>;
}

/**
 * Reads seals straight from a Sui fullnode, not through OctaP. Answers null when the object is
 * missing, is not an `EvidenceSeal` of the trusted package, or is not frozen: none of those is a
 * seal OctaP could have made.
 */
export function suiSealReader(network: AuditNetwork | string, options: { rpcUrl?: string } = {}): SealReader {
  const config = auditNetwork(network);
  const client = new SuiGrpcClient({
    network: network as AuditNetwork,
    baseUrl: options.rpcUrl ?? config.rpcUrl,
  });
  const expectedType = normalizeStructTag(`${config.packageId}::evidence_seal::EvidenceSeal`);
  return {
    async readSeal(sealObjectId) {
      let object;
      try {
        ({ object } = await client.core.getObject({
          objectId: sealObjectId,
          include: { content: true, previousTransaction: true },
        }));
      } catch (err: unknown) {
        if (err instanceof ObjectError && (err.reason === 'notFound' || err.reason === 'deleted')) return null;
        throw err;
      }
      if (normalizeStructTag(object.type) !== expectedType) return null;
      if (object.owner.$kind !== 'Immutable') return null;
      return parseSeal(object.content, object.previousTransaction ?? null);
    },
  };
}

export function parseSeal(content: Uint8Array, transactionDigest: string | null): OnChainSeal {
  const raw = EvidenceSealBcs.parse(content);
  const previous = Uint8Array.from(raw.previous_manifest_hash);
  return {
    sealObjectId: normalizeSuiAddress(raw.id),
    organizationId: new TextDecoder().decode(Uint8Array.from(raw.organization_id)),
    periodStartMs: Number(raw.period_start_ms),
    periodEndMs: Number(raw.period_end_ms),
    manifestHash: bytesToHex(Uint8Array.from(raw.manifest_hash)),
    previousManifestHash: previous.length ? bytesToHex(previous) : null,
    sealedAtMs: Number(raw.sealed_at_ms),
    transactionDigest,
  };
}

/** For tests and for anyone who wants to build the same bytes. */
export function encodeSealForTesting(seal: Omit<OnChainSeal, 'transactionDigest'>): Uint8Array {
  const hex = (h: string | null) => (h ? Array.from(hexToBytes(h)) : []);
  return EvidenceSealBcs.serialize({
    id: seal.sealObjectId,
    organization_id: Array.from(new TextEncoder().encode(seal.organizationId)),
    period_start_ms: BigInt(seal.periodStartMs),
    period_end_ms: BigInt(seal.periodEndMs),
    manifest_hash: hex(seal.manifestHash),
    previous_manifest_hash: hex(seal.previousManifestHash),
    sealed_at_ms: BigInt(seal.sealedAtMs),
  }).toBytes();
}
