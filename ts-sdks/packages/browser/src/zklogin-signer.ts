import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getZkLoginSignature, type ZkLoginSignatureInputs } from '@mysten/sui/zklogin';
import type { CoreApi } from './core-api.js';
import { OctapAuthError } from './errors.js';

/**
 * The zkLogin signer: ephemeral key, nonce, proof and signature. It only ever receives an id_token,
 * so it knows nothing about the provider that issued it. The private key stays on this device:
 * only `toSuiPublicKey()` is ever sent.
 */
interface NonceResponse {
  nonce: string;
  randomness: string;
  maxEpoch: number;
  estimatedExpiration: number;
}

export interface SignerState {
  secretKey: string;
  maxEpoch: number;
  /** Core's estimate of when `maxEpoch` ends, in milliseconds since the epoch. */
  expiresAt: number;
  proof: ZkLoginSignatureInputs;
}

export function isZkProof(value: unknown): value is ZkLoginSignatureInputs {
  const proof = value as Partial<ZkLoginSignatureInputs> | null;
  return (
    typeof proof?.addressSeed === 'string' &&
    typeof proof.headerBase64 === 'string' &&
    typeof proof.issBase64Details?.value === 'string' &&
    Array.isArray(proof.proofPoints?.a) &&
    Array.isArray(proof.proofPoints.b) &&
    Array.isArray(proof.proofPoints.c)
  );
}

/** A key and nonce waiting for the customer to sign in. */
export class PendingSignIn {
  private constructor(
    private readonly keypair: Ed25519Keypair,
    private readonly params: NonceResponse,
  ) {}

  static async start(api: CoreApi): Promise<PendingSignIn> {
    const keypair = new Ed25519Keypair();
    const params = await api.post<NonceResponse>('/v1/identity/zklogin/nonce', {
      ephemeralPublicKey: keypair.getPublicKey().toSuiPublicKey(),
    });
    if (
      typeof params.nonce !== 'string' ||
      !params.nonce ||
      typeof params.randomness !== 'string' ||
      !Number.isFinite(params.maxEpoch) ||
      !Number.isFinite(params.estimatedExpiration)
    ) {
      throw new OctapAuthError('invalid-response', 'OctaP returned an invalid sign-in nonce.', { body: params });
    }
    return new PendingSignIn(keypair, params);
  }

  get nonce(): string {
    return this.params.nonce;
  }

  /** A flow check, not token validation: Enoki validates the token's signature. */
  assertIssuedForThisAttempt(idToken: string): void {
    if (Date.now() >= this.params.estimatedExpiration) {
      throw new OctapAuthError('session-expired', 'This sign-in attempt expired. Sign in again.');
    }
    let nonce: unknown;
    try {
      nonce = (decodePayload(idToken) as { nonce?: unknown }).nonce;
    } catch {
      throw new OctapAuthError('nonce-mismatch', 'Google returned an unreadable token. Sign in again.');
    }
    if (nonce !== this.params.nonce) {
      throw new OctapAuthError('nonce-mismatch', 'Google sign-in did not match this attempt. Sign in again.');
    }
  }

  async prove(api: CoreApi, idToken: string): Promise<SignerState> {
    const proof = await api.post<ZkLoginSignatureInputs>('/v1/identity/zklogin/proof', {
      idToken,
      ephemeralPublicKey: this.keypair.getPublicKey().toSuiPublicKey(),
      randomness: this.params.randomness,
      maxEpoch: this.params.maxEpoch,
    });
    if (!isZkProof(proof)) {
      throw new OctapAuthError('invalid-response', 'OctaP returned an invalid signing proof.', { body: proof });
    }
    return {
      secretKey: this.keypair.getSecretKey(),
      maxEpoch: this.params.maxEpoch,
      expiresAt: this.params.estimatedExpiration,
      proof,
    };
  }
}

function decodePayload(idToken: string): unknown {
  const payload = idToken.split('.')[1];
  const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Seconds since the epoch at which an id_token stops being valid, or undefined if unreadable. */
export function idTokenExpiry(idToken: string): number | undefined {
  try {
    const { exp } = decodePayload(idToken) as { exp?: unknown };
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** Signs for the signed-in customer, refusing bytes that name a different sender. */
export async function signWithZkLogin(
  state: SignerState,
  suiAddress: string,
  transactionBytes: string,
): Promise<string> {
  let bytes: Uint8Array;
  let sender: string | null | undefined;
  try {
    bytes = fromBase64(transactionBytes);
    sender = Transaction.from(bytes).getData().sender;
  } catch {
    throw new OctapAuthError('invalid-claim', 'These transaction bytes cannot be read.');
  }
  if (sender !== suiAddress) {
    throw new OctapAuthError(
      'wrong-account',
      'This transaction belongs to a different account than the one signed in. Sign in with that account.',
    );
  }
  try {
    const { signature: userSignature } = await Ed25519Keypair.fromSecretKey(state.secretKey).signTransaction(bytes);
    return getZkLoginSignature({ inputs: state.proof, maxEpoch: state.maxEpoch, userSignature });
  } catch {
    throw new OctapAuthError('session-expired', 'The signing session cannot be used. Sign in again.');
  }
}
