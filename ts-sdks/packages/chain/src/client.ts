import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Signer } from '@mysten/sui/cryptography';

import * as creditAccount from './contracts/octap/credit_account.js';
import { TESTNET_OCTAP_PACKAGE_CONFIG, type OctapPackageConfig } from './constants.js';

export type OctapNetwork = 'testnet' | 'devnet' | 'mainnet' | 'localnet';

const NETWORK_GRPC_URLS: Record<OctapNetwork, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

export interface OctapChainClientOptions {
  network?: OctapNetwork;
  rpcUrl?: string;
  package?: OctapPackageConfig;
}

export interface OpenAccountParams {
  issuerCapId: string;
  programId: string;
  beneficiary: string;
}

export interface EarnParams {
  issuerCapId: string;
  programId: string;
  policyId: string;
  accountId: string;
  /** Smallest currency unit of the underlying purchase, not a credit amount. */
  purchaseAmount: number | bigint;
  /** Off-chain command/idempotency key, for event correlation only (see credit_account.move docs). */
  operationKey: Uint8Array;
}

export interface RedeemParams {
  accountId: string;
  /** Credit amount to debit, already resolved off-chain (e.g. a voucher's credit cost). */
  cost: number | bigint;
  /** Opaque off-chain reference (e.g. a redemption id), for event correlation. */
  reference: Uint8Array;
}

export interface SubmittedChainTransaction {
  digest: string;
  status: 'success' | 'failure';
  errorMessage?: string;
  events: Array<{ type: string; parsedJson: unknown }>;
}

/**
 * Thin, backend-only wrapper around the generated `octap` Move bindings.
 *
 * This is deliberately NOT part of the public SDK surface (`@octap/node`,
 * `@octap/browser`): it speaks in Move object ids, capability objects, and
 * raw on-chain amounts, none of which a merchant integrator or end user
 * should ever see. Only `api/src/infra/clients/sui` imports this package;
 * everything it returns gets translated into the existing `@octap/contracts`
 * wire types before it reaches a response body.
 *
 * Uses `SuiGrpcClient`, matching `docs/architecture.md`'s "Sui gRPC adapter"
 * — not `SuiJsonRpcClient`, which public fullnodes have already fully
 * decommissioned (confirmed live against testnet: `getCoins` returns
 * `-32601 Method not found`, not a soft deprecation warning).
 */
export class OctapChainClient {
  readonly rpc: SuiGrpcClient;
  private readonly packageId: string;

  constructor(options: OctapChainClientOptions = {}) {
    const network = options.network ?? 'testnet';
    this.packageId = (options.package ?? TESTNET_OCTAP_PACKAGE_CONFIG).packageId;
    this.rpc = new SuiGrpcClient({
      network,
      baseUrl: options.rpcUrl ?? NETWORK_GRPC_URLS[network],
    });
  }

  buildOpenAccountTransaction(params: OpenAccountParams): Transaction {
    const tx = new Transaction();
    creditAccount.openAccount({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        program: params.programId,
        beneficiary: params.beneficiary,
      },
    })(tx);
    return tx;
  }

  buildEarnTransaction(params: EarnParams): Transaction {
    const tx = new Transaction();
    creditAccount.earn({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        program: params.programId,
        policy: params.policyId,
        account: params.accountId,
        purchaseAmount: params.purchaseAmount,
        operationKey: Array.from(params.operationKey),
      },
    })(tx);
    return tx;
  }

  buildRedeemTransaction(params: RedeemParams): Transaction {
    const tx = new Transaction();
    creditAccount.redeem({
      package: this.packageId,
      arguments: {
        account: params.accountId,
        cost: params.cost,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  /** Signs and submits `tx`, waits for it to be checkpointed, and returns a normalized result. */
  async signAndExecute(tx: Transaction, signer: Signer): Promise<SubmittedChainTransaction> {
    const submitted = await this.rpc.core.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { effects: true, events: true },
    });

    const result = submitted.$kind === 'Transaction' ? submitted.Transaction : submitted.FailedTransaction;
    await this.rpc.core.waitForTransaction({ digest: result.digest, include: { effects: true, events: true } });

    const status = result.status.success ? 'success' : 'failure';
    return {
      digest: result.digest,
      status,
      errorMessage: result.status.success ? undefined : result.status.error.message,
      events: (result.events ?? []).map((event) => ({ type: event.eventType, parsedJson: event.json })),
    };
  }
}

/** Decodes a `suiprivkey1...` string into a signer. Only ed25519 is supported today. */
export function signerFromPrivateKey(bech32PrivateKey: string): Ed25519Keypair {
  const decoded = decodeSuiPrivateKey(bech32PrivateKey);
  if (decoded.scheme !== 'ED25519') {
    throw new Error(`Unsupported key scheme "${decoded.scheme}"; only ed25519 issuer/admin keys are supported today.`);
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}
