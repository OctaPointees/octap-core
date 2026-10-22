import { Injectable } from '@nestjs/common';
import { EnokiClient as MystenEnokiClient } from '@mysten/enoki/client';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { toBase64 } from '@mysten/sui/utils';
import { requireEnv } from '../require-env.js';

export type EnokiNetwork = 'mainnet' | 'testnet' | 'devnet';

/**
 * `@mysten/enoki/client` only exports the `EnokiClient` class itself, not its individual
 * request/response shapes (those live under an internal, non-exported path) — deriving the type
 * from the method itself is the portable way to name it.
 */
export type ZkLoginProofResult = Awaited<ReturnType<MystenEnokiClient['createZkLoginZkp']>>;

/**
 * Thin wrapper around `@mysten/enoki/client`'s low-level `EnokiClient`. `ENOKI_API_KEY` is an app
 * credential, not a signer key — unlike `SUI_ISSUER_PRIVATE_KEY` it's fine for the internet-facing
 * HTTP process to hold, so this is registered in `infra/infrastructure.module.ts`, not
 * `worker.module.ts`. Nothing here signs a transaction: Enoki signs its own sponsor side
 * server-side, and the end user signs their own side with an ephemeral key this process never
 * sees (see `domain/identity/README.md`).
 */
@Injectable()
export class EnokiClient {
  private client?: MystenEnokiClient;

  private get sdk(): MystenEnokiClient {
    if (!this.client) {
      this.client = new MystenEnokiClient({ apiKey: requireEnv('ENOKI_API_KEY', 'Enoki adapter') });
    }
    return this.client;
  }

  /**
   * Resolves the zkLogin Sui address Enoki derives for a provider id_token (Google today).
   * Enoki itself validates the token's signature, issuer, and audience — this process never
   * verifies a Google JWT on its own.
   */
  async resolveZkLoginAddress(jwt: string): Promise<{ address: string; publicKey: string; salt: string }> {
    return this.sdk.getZkLogin({ jwt });
  }

  /**
   * Proxies nonce creation so a frontend never needs its own Enoki credential: the client holds
   * its ephemeral keypair and sends only the public half, in the standard self-describing
   * Sui-flagged base64 form (`keypair.getPublicKey().toSuiPublicKey()`).
   */
  async createZkLoginNonce(params: {
    network?: EnokiNetwork;
    ephemeralPublicKey: string;
    additionalEpochs?: number;
  }): Promise<{ nonce: string; randomness: string; epoch: number; maxEpoch: number; estimatedExpiration: number }> {
    return this.sdk.createZkLoginNonce({
      network: params.network,
      ephemeralPublicKey: publicKeyFromSuiBytes(params.ephemeralPublicKey),
      additionalEpochs: params.additionalEpochs,
    });
  }

  /** Proxies ZK proof generation for the ephemeral keypair the client already holds. */
  async createZkLoginProof(params: {
    network?: EnokiNetwork;
    jwt: string;
    ephemeralPublicKey: string;
    randomness: string;
    maxEpoch: number;
  }): Promise<ZkLoginProofResult> {
    return this.sdk.createZkLoginZkp({
      network: params.network,
      jwt: params.jwt,
      ephemeralPublicKey: publicKeyFromSuiBytes(params.ephemeralPublicKey),
      randomness: params.randomness,
      maxEpoch: params.maxEpoch,
    });
  }

  /**
   * Sponsors gas for transaction kind bytes this process built itself — never bytes a client
   * supplied — restricted to `allowedMoveCallTargets`, which Enoki enforces server-side as a
   * second line of defense on top of the caller's own allowlist check.
   */
  async createSponsoredTransaction(params: {
    network?: EnokiNetwork;
    transactionKindBytes: Uint8Array;
    sender: string;
    allowedMoveCallTargets: string[];
  }): Promise<{ bytes: string; digest: string }> {
    return this.sdk.createSponsoredTransaction({
      network: params.network,
      transactionKindBytes: toBase64(params.transactionKindBytes),
      sender: params.sender,
      allowedAddresses: [params.sender],
      allowedMoveCallTargets: params.allowedMoveCallTargets,
    });
  }

  /** Executes a sponsored transaction once Enoki's sponsor signature and the user's are both in. */
  async executeSponsoredTransaction(params: { digest: string; signature: string }): Promise<{ digest: string }> {
    return this.sdk.executeSponsoredTransaction(params);
  }
}
