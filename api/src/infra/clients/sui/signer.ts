import type { Logger } from '@nestjs/common';
import { AwsKmsSigner, type AwsCredentialProvider } from '@mysten/aws-kms-signer';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { Signer } from '@mysten/sui/cryptography';
import { signerFromPrivateKey, type OctapNetwork } from '@octap/chain';

/** Where one worker signer's key comes from: an AWS KMS key, or (off mainnet) a raw key. */
export interface SignerSource {
  /** Env var naming the AWS KMS key: key id, key ARN, `alias/<name>`, or alias ARN. */
  kmsKeyIdEnv: string;
  /** Env var holding a bech32 `suiprivkey1...` ed25519 key — the local fallback, refused on mainnet. */
  privateKeyEnv: string;
  /** Names the adapter in errors and logs. */
  adapter: string;
}

export const ISSUER_SIGNER: SignerSource = {
  kmsKeyIdEnv: 'SUI_ISSUER_KMS_KEY_ID',
  privateKeyEnv: 'SUI_ISSUER_PRIVATE_KEY',
  adapter: 'Sui chain adapter',
};

export const PROGRAM_ADMIN_SIGNER: SignerSource = {
  kmsKeyIdEnv: 'SUI_PROGRAM_ADMIN_KMS_KEY_ID',
  privateKeyEnv: 'SUI_PROGRAM_ADMIN_PRIVATE_KEY',
  adapter: 'program admin adapter',
};

/**
 * Resolves `source`'s signer. An AWS KMS key wins whenever its env var is set: the private key
 * never leaves KMS, and this process only holds the key reference plus whatever the standard AWS
 * credential chain resolves (`AWS_PROFILE`, env keys, SSO, or an ECS/EKS/EC2 role — the same code
 * on a laptop and on AWS compute). The signature scheme comes from the key's own `KeySpec`
 * (`ECC_NIST_EDWARDS25519` or `ECC_SECG_P256K1`), never assumed here.
 *
 * Without a KMS key, falls back to the raw key in `privateKeyEnv` for local work, with a warning.
 * Mainnet refuses that fallback outright: a mainnet signer is KMS or nothing.
 */
export async function loadSigner(source: SignerSource, network: OctapNetwork, logger: Logger): Promise<Signer> {
  const kmsKeyId = process.env[source.kmsKeyIdEnv]?.trim();
  if (kmsKeyId) {
    const signer = await loadKmsSigner(kmsKeyId, source);
    logger.log(`${source.adapter} signs as ${signer.toSuiAddress()} via AWS KMS key ${kmsKeyId}`);
    return signer;
  }

  const privateKey = process.env[source.privateKeyEnv]?.trim();
  if (!privateKey) {
    throw new Error(
      `Missing signer for the ${source.adapter}: set ${source.kmsKeyIdEnv} to an AWS KMS key` +
        (network === 'mainnet' ? '' : ` (or ${source.privateKeyEnv} to a raw key for local use)`),
    );
  }
  if (network === 'mainnet') {
    throw new Error(
      `${source.privateKeyEnv} is a raw private key; the ${source.adapter} signs on mainnet only through AWS KMS (${source.kmsKeyIdEnv})`,
    );
  }
  logger.warn(`${source.adapter} is signing with the raw key in ${source.privateKeyEnv}, not AWS KMS`);
  return signerFromPrivateKey(privateKey);
}

/**
 * `loadSigner` once per process: the KMS public key is fetched on first use and kept, so every
 * later signature costs exactly one KMS `Sign` round trip. A failed load is not cached, so a
 * transient KMS or credential error doesn't wedge the worker until restart.
 */
export function memoizeSigner(load: () => Promise<Signer>): () => Promise<Signer> {
  let pending: Promise<Signer> | undefined;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

let awsCredentials: AwsCredentialProvider | undefined;

async function loadKmsSigner(keyId: string, source: SignerSource): Promise<AwsKmsSigner> {
  // One provider per process: it caches and refreshes temporary credentials itself.
  awsCredentials ??= defaultProvider();
  const region = kmsRegion(keyId, source);
  try {
    return await AwsKmsSigner.fromKeyId(keyId, { region, credentials: awsCredentials });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AWS KMS key ${keyId} (${source.kmsKeyIdEnv}) is unusable for the ${source.adapter}: ${message}`);
  }
}

/** A key ARN carries its own region; a bare key id or alias name needs `AWS_REGION`. */
export function kmsRegion(keyId: string, source: SignerSource): string {
  const region = /^arn:aws[\w-]*:kms:([a-z0-9-]+):/.exec(keyId)?.[1] ?? process.env.AWS_REGION?.trim();
  if (!region) {
    throw new Error(`Missing required env var AWS_REGION for the ${source.adapter}'s KMS key ${keyId}`);
  }
  return region;
}
