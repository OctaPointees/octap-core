import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Signer } from '@mysten/sui/cryptography';

import * as creditAccount from './contracts/octap/credit_account.js';
import * as programControl from './contracts/octap/program_control.js';
import * as policyVersion from './contracts/octap/policy_version.js';
import * as operationShard from './contracts/octap/operation_shard.js';
import * as budgetShard from './contracts/octap/budget_shard.js';
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
  /** The program's `OperationShard` that owns `operationKey` (see `operationShardIndex`). */
  operationShardId: string;
  /** The program's `BudgetShard` at the same index as `operationShardId`. */
  budgetShardId: string;
  /** Smallest currency unit of the underlying purchase, not a credit amount. */
  purchaseAmount: number | bigint;
  /** Off-chain command/idempotency key; recorded on-chain so a replay of it aborts. */
  operationKey: Uint8Array;
}

export interface RedeemParams {
  accountId: string;
  /** Credit amount to debit, already resolved off-chain (e.g. a voucher's credit cost). */
  cost: number | bigint;
  /** Opaque off-chain reference (e.g. a redemption id), for event correlation. */
  reference: Uint8Array;
}

export interface PublishPolicyParams {
  adminCapId: string;
  programId: string;
  version: number | bigint;
  /** Credits earned per 10,000 units of purchase amount (basis points). */
  earnBps: number | bigint;
  /** How long, in milliseconds from the moment of earning, a bucket stays spendable. */
  expiryMs: number | bigint;
}

export interface ActivatePolicyAndIssueCapParams {
  adminCapId: string;
  programId: string;
  policyVersionId: string;
  /** The address backing the service signer that will call `earn` for this program. */
  issuerRecipient: string;
  /**
   * Also create the program's operation and budget shards in the same transaction, so a fresh
   * program never ends up activated but shardless (and so unable to `earn`).
   */
  shards?: Pick<CreateShardsParams, 'shardCount' | 'totalBudget'>;
}

export interface CreateShardsParams {
  adminCapId: string;
  programId: string;
  /** Number of operation shards and of budget shards — always equal, see `budget_shard.move`. */
  shardCount: number | bigint;
  /** Total issuance budget in credits, split evenly across budget shards (remainder to shard 0). */
  totalBudget: number | bigint;
}

export interface SubmittedChainTransaction {
  digest: string;
  status: 'success' | 'failure';
  errorMessage?: string;
  events: Array<{ type: string; parsedJson: unknown }>;
}

/** The first value of `field` on any event of `result` whose type ends in `::<eventSuffix>`. */
export function eventField<T = unknown>(
  result: SubmittedChainTransaction,
  eventSuffix: string,
  field: string,
): T | undefined {
  const event = result.events.find((e) => e.type.endsWith(`::${eventSuffix}`));
  return (event?.parsedJson as Record<string, unknown> | undefined)?.[field] as T | undefined;
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
        operationShard: params.operationShardId,
        budgetShard: params.budgetShardId,
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

  /**
   * Creates a new program and mints its `AdminCap` to the signer — the only entry point in
   * this file not scoped to an existing program, since there is no program yet to scope it to.
   */
  buildCreateProgramTransaction(): Transaction {
    const tx = new Transaction();
    programControl.createProgramEntry({ package: this.packageId })(tx);
    return tx;
  }

  /**
   * Publishes and freezes a new policy version for `params.programId`. Must be its own
   * transaction: the `ProgramControl` this targets was shared (and its id only became known)
   * in a prior transaction's effects, not a value this PTB can reference directly.
   */
  buildPublishPolicyTransaction(params: PublishPolicyParams): Transaction {
    const tx = new Transaction();
    policyVersion.publish({
      package: this.packageId,
      arguments: {
        admin: params.adminCapId,
        programId: params.programId,
        version: params.version,
        earnBps: params.earnBps,
        expiryMs: params.expiryMs,
      },
    })(tx);
    return tx;
  }

  /**
   * Activates `params.policyVersionId` for `params.programId` and mints an `IssuerCap` for
   * `params.issuerRecipient`, in one transaction — both commands only need objects that
   * already exist on-chain from prior transactions, so there's no same-PTB ordering problem
   * here the way there is between `create_program` and `publish`.
   */
  buildActivatePolicyAndIssueCapTransaction(params: ActivatePolicyAndIssueCapParams): Transaction {
    const tx = new Transaction();
    programControl.activatePolicy({
      package: this.packageId,
      arguments: {
        admin: params.adminCapId,
        program: params.programId,
        policy: params.policyVersionId,
      },
    })(tx);
    programControl.issueCap({
      package: this.packageId,
      arguments: {
        admin: params.adminCapId,
        program: params.programId,
        recipient: params.issuerRecipient,
      },
    })(tx);
    if (params.shards) {
      this.addCreateShards(tx, { adminCapId: params.adminCapId, programId: params.programId, ...params.shards });
    }
    return tx;
  }

  /**
   * Creates and shares a program's operation and budget shards in one transaction — both only
   * need the `AdminCap` and the program id, which already exist from prior transactions. Shard
   * ids come back on the `OperationShardCreated`/`BudgetShardCreated` events.
   */
  buildCreateShardsTransaction(params: CreateShardsParams): Transaction {
    const tx = new Transaction();
    this.addCreateShards(tx, params);
    return tx;
  }

  private addCreateShards(tx: Transaction, params: CreateShardsParams): void {
    operationShard.createShards({
      package: this.packageId,
      arguments: {
        admin: params.adminCapId,
        programId: params.programId,
        shardCount: params.shardCount,
      },
    })(tx);
    budgetShard.createShards({
      package: this.packageId,
      arguments: {
        admin: params.adminCapId,
        programId: params.programId,
        totalBudget: params.totalBudget,
        shardCount: params.shardCount,
      },
    })(tx);
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

  /**
   * Reads back a transaction this process did not sign or submit itself — e.g. one Enoki
   * executed on a sponsored signer's behalf. Polls until checkpointed, same as the tail of
   * `signAndExecute`, but starting from only a digest.
   */
  async waitForTransaction(digest: string): Promise<SubmittedChainTransaction> {
    const waited = await this.rpc.core.waitForTransaction({ digest, include: { effects: true, events: true } });
    const result = waited.$kind === 'Transaction' ? waited.Transaction : waited.FailedTransaction;

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
