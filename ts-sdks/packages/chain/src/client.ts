import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { ObjectError, SimulationError, TransactionError, type SuiClientTypes } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { Signer } from '@mysten/sui/cryptography';

import * as creditAccount from './contracts/octap/credit_account.js';
import * as voucherTerms from './contracts/octap/voucher_terms.js';
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

/**
 * One program's on-chain object ids — what `earn`/`open_account` need besides the package. Each
 * organization has its own, provisioned once and persisted in the API's `programs` table; there
 * is deliberately no committed default program.
 */
export interface OctapProgramConfig {
  /** Shared `octap::program_control::ProgramControl` object id. */
  programControlId: string;
  /** Immutable `octap::policy_version::PolicyVersion` currently activated for this program. */
  policyVersionId: string;
  /** `octap::capabilities::IssuerCap` authorizing `earn` for this program. */
  issuerCapId: string;
  /**
   * Shared `octap::operation_shard::OperationShard` ids, in shard-index order. `earn` must be
   * given `operationShardIds[operationShardIndex(key, operationShardIds.length)]`.
   */
  operationShardIds: readonly string[];
  /** Shared `octap::budget_shard::BudgetShard` ids, in shard-index order; same length as above. */
  budgetShardIds: readonly string[];
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

export interface PublishVoucherTermsParams {
  issuerCapId: string;
  programId: string;
  /** The off-chain voucher id, for correlating the event. */
  reference: Uint8Array;
  /** Canonical JSON of the promise. */
  terms: Uint8Array;
  pointsCost: number | bigint;
  /** Zero means no start limit. */
  startsAtMs: number | bigint;
  /** Zero means it never expires. */
  expiresAtMs: number | bigint;
}

export interface ClaimVoucherParams {
  accountId: string;
  termsId: string;
  reference: Uint8Array;
}

export interface GrantVoucherParams {
  issuerCapId: string;
  accountId: string;
  termsId: string;
  reference: Uint8Array;
}

export interface UseVoucherParams {
  accountId: string;
  termsId: string;
  reference: Uint8Array;
}

export interface CancelVoucherParams {
  issuerCapId: string;
  accountId: string;
  reference: Uint8Array;
}

export interface ReverseEarnParams {
  issuerCapId: string;
  accountId: string;
  /** The program's `OperationShard` that owns `operationKey` — the one the earn recorded it in. */
  operationShardId: string;
  /** The program's `BudgetShard` at the same index; the earn's budget is refunded to it. */
  budgetShardId: string;
  /** The original earn's `operation_key`. */
  operationKey: Uint8Array;
}

export interface ReverseRedeemParams {
  issuerCapId: string;
  accountId: string;
  /** The original `redeem`'s `reference`. */
  reference: Uint8Array;
}

export interface CreditAccountEvent {
  /** Struct name only (`CreditEarned`, `CreditRedeemed`, ...), package/module prefix stripped. */
  name: string;
  sender: string;
  /** Move struct fields as the gRPC transport renders them: u64 as decimal strings, vector<u8> as base64. */
  json: Record<string, unknown> | null;
  checkpoint: string | null;
  transactionDigest: string;
  eventIndex: number;
}

export interface CreditAccountEventPage {
  events: CreditAccountEvent[];
  hasNextPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
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

export interface TopUpBudgetParams {
  adminCapId: string;
  /** Credits to add per `BudgetShard` id; each must be positive (`budget_shard::EZeroTopUp`). */
  topUps: ReadonlyArray<{ budgetShardId: string; amount: number | bigint }>;
}

export interface SubmittedChainTransaction {
  digest: string;
  status: 'success' | 'failure';
  errorMessage?: string;
  /** Set when a failure was a Move `abort`: where it aborted and with which code. */
  moveAbort?: ChainMoveAbort;
  events: Array<{ type: string; parsedJson: unknown }>;
}

/** A Move abort, structured (`errorMessage` carries the same thing as display text). */
export interface ChainMoveAbort {
  module?: string;
  functionName?: string;
  /** Decimal string, e.g. `'0'` for `credit_account::EWrongProgram`. */
  abortCode: string;
}

/**
 * A fully built and signed transaction that has not been sent yet. `digest` is known before
 * anything leaves the process, so a caller can persist it first and later ask the chain what
 * became of exactly this transaction, whatever happened to the connection that sent it.
 */
export interface SignedChainTransaction {
  bytes: Uint8Array;
  signature: string;
  digest: string;
  /** Last epoch the transaction can execute in (see `transactionExpirationEpoch`). */
  expirationEpoch: bigint | null;
}

/**
 * The last epoch in which `bytes` can still execute, or null if it never expires. Once the chain
 * is past that epoch, a digest that was never found can never land.
 */
export function transactionExpirationEpoch(bytes: Uint8Array | string): bigint | null {
  const expiration = Transaction.from(bytes).getData().expiration;
  if (expiration?.$kind === 'Epoch') {
    return BigInt(expiration.Epoch);
  }
  if (expiration?.$kind === 'ValidDuring' && expiration.ValidDuring.maxEpoch !== null) {
    return BigInt(expiration.ValidDuring.maxEpoch);
  }
  return null;
}

type CoreTransactionResult = SuiClientTypes.TransactionResult<{ effects: true; events: true }>;

function toMoveAbort(error: SuiClientTypes.ExecutionError | null | undefined): ChainMoveAbort | undefined {
  if (error?.$kind !== 'MoveAbort') {
    return undefined;
  }
  return {
    module: error.MoveAbort.location?.module,
    functionName: error.MoveAbort.location?.functionName,
    abortCode: error.MoveAbort.abortCode,
  };
}

/**
 * The Move abort behind an error thrown while *building* a transaction. Building simulates it
 * first, so an abort the chain would hit (e.g. `EWrongProgram`) usually surfaces here, as the
 * SDK's `SimulationError`, before anything is signed or sent. Undefined for any other error.
 */
export function moveAbortOf(err: unknown): ChainMoveAbort | undefined {
  return err instanceof SimulationError ? toMoveAbort(err.executionError) : undefined;
}

function normalizeResult(response: CoreTransactionResult): SubmittedChainTransaction {
  const result = response.$kind === 'Transaction' ? response.Transaction : response.FailedTransaction;
  const moveAbort = result.status.success ? undefined : toMoveAbort(result.status.error);
  return {
    digest: result.digest,
    status: result.status.success ? 'success' : 'failure',
    errorMessage: result.status.success ? undefined : result.status.error.message,
    ...(moveAbort ? { moveAbort } : {}),
    events: (result.events ?? []).map((event) => ({ type: event.eventType, parsedJson: event.json })),
  };
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

  buildPublishVoucherTermsTransaction(params: PublishVoucherTermsParams): Transaction {
    const tx = new Transaction();
    voucherTerms.publishTerms({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        program: params.programId,
        reference: Array.from(params.reference),
        terms: Array.from(params.terms),
        pointsCost: params.pointsCost,
        startsAtMs: params.startsAtMs,
        expiresAtMs: params.expiresAtMs,
      },
    })(tx);
    return tx;
  }

  buildClaimVoucherTransaction(params: ClaimVoucherParams): Transaction {
    const tx = new Transaction();
    creditAccount.claimVoucher({
      package: this.packageId,
      arguments: {
        account: params.accountId,
        terms: params.termsId,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  buildGrantVoucherTransaction(params: GrantVoucherParams): Transaction {
    const tx = new Transaction();
    creditAccount.grantVoucher({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        account: params.accountId,
        terms: params.termsId,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  buildUseVoucherTransaction(params: UseVoucherParams): Transaction {
    const tx = new Transaction();
    creditAccount.useVoucher({
      package: this.packageId,
      arguments: {
        account: params.accountId,
        terms: params.termsId,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  buildCancelVoucherTransaction(params: CancelVoucherParams): Transaction {
    const tx = new Transaction();
    creditAccount.cancelVoucher({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        account: params.accountId,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  buildReverseEarnTransaction(params: ReverseEarnParams): Transaction {
    const tx = new Transaction();
    creditAccount.reverseEarn({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        account: params.accountId,
        operationShard: params.operationShardId,
        budgetShard: params.budgetShardId,
        operationKey: Array.from(params.operationKey),
      },
    })(tx);
    return tx;
  }

  buildReverseRedeemTransaction(params: ReverseRedeemParams): Transaction {
    const tx = new Transaction();
    creditAccount.reverseRedeem({
      package: this.packageId,
      arguments: {
        issuer: params.issuerCapId,
        account: params.accountId,
        reference: Array.from(params.reference),
      },
    })(tx);
    return tx;
  }

  /**
   * Pages through every event `octap::credit_account` emitted, in ledger order. A thin pass-through
   * to `core.listEvents`: `after` is an opaque cursor from a previous page's `endCursor` (or, after
   * a descending read, its `startCursor`), and a scan-limited page can come back empty with
   * `hasNextPage: true` — continuing from its `endCursor` still makes progress.
   */
  async listCreditAccountEvents(options: {
    after?: string | null;
    limit?: number;
    order?: 'ascending' | 'descending';
  }): Promise<CreditAccountEventPage> {
    const page = await this.rpc.core.listEvents({
      filter: { emitModule: `${this.packageId}::credit_account` },
      after: options.after ?? undefined,
      limit: options.limit,
      order: options.order,
    });
    return {
      events: page.events.map((event) => ({
        name: event.eventType.split('::').pop() ?? event.eventType,
        sender: event.sender,
        json: event.json,
        checkpoint: event.checkpoint,
        transactionDigest: event.transactionDigest,
        eventIndex: event.eventIndex,
      })),
      hasNextPage: page.hasNextPage,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
    };
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

  /**
   * Refills one or more of a program's `BudgetShard`s in one transaction, one `top_up` call per
   * entry. `AdminCap`-gated on-chain: the `IssuerCap` signer can't build a valid one of these.
   */
  buildTopUpBudgetTransaction(params: TopUpBudgetParams): Transaction {
    const tx = new Transaction();
    for (const { budgetShardId, amount } of params.topUps) {
      budgetShard.topUp({
        package: this.packageId,
        arguments: { admin: params.adminCapId, shard: budgetShardId, amount },
      })(tx);
    }
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
    return this.executeSigned(await this.sign(tx, signer));
  }

  /**
   * Builds and signs `tx` without sending it. Every result expires, so a transaction that never
   * reached the network provably can't land once the chain is past `expirationEpoch`: gas paid from
   * the address balance already gets a short `ValidDuring` window from the SDK (the chain requires
   * one), and anything that would build without an expiration is pinned to the current epoch.
   * Errors here are definitive: nothing was sent.
   */
  async sign(tx: Transaction, signer: Signer): Promise<SignedChainTransaction> {
    tx.setSenderIfNotSet(signer.toSuiAddress());
    let bytes = await tx.build({ client: this.rpc });
    if (transactionExpirationEpoch(bytes) === null) {
      tx.setExpiration({ Epoch: String(await this.currentEpoch()) });
      bytes = await tx.build({ client: this.rpc });
    }
    const { signature } = await signer.signTransaction(bytes);
    return {
      bytes,
      signature,
      digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      expirationEpoch: transactionExpirationEpoch(bytes),
    };
  }

  /** Sends a transaction from `sign`, waits for it to be checkpointed, and returns a normalized result. */
  async executeSigned(signed: SignedChainTransaction): Promise<SubmittedChainTransaction> {
    const submitted = await this.rpc.core.executeTransaction({
      transaction: signed.bytes,
      signatures: [signed.signature],
      include: { effects: true, events: true },
    });
    const result = normalizeResult(submitted);
    await this.rpc.core.waitForTransaction({ digest: result.digest, include: { effects: true, events: true } });
    return result;
  }

  /**
   * Reads back a transaction this process did not sign or submit itself — e.g. one Enoki
   * executed on a sponsored signer's behalf. Polls until checkpointed, same as the tail of
   * `signAndExecute`, but starting from only a digest.
   */
  async waitForTransaction(digest: string): Promise<SubmittedChainTransaction> {
    return normalizeResult(
      await this.rpc.core.waitForTransaction({ digest, include: { effects: true, events: true } }),
    );
  }

  /** One lookup, no polling: the transaction's outcome, or null if the chain has no such digest (yet). */
  async findTransaction(digest: string): Promise<SubmittedChainTransaction | null> {
    try {
      return normalizeResult(await this.rpc.core.getTransaction({ digest, include: { effects: true, events: true } }));
    } catch (err: unknown) {
      if (err instanceof TransactionError && err.reason === 'notFound') {
        return null;
      }
      throw err;
    }
  }

  /**
   * The program a `CreditAccount` was opened in (its `program_id` field), read straight from the
   * object — no transaction. Null if there is no such object.
   */
  async creditAccountProgramId(accountId: string): Promise<string | null> {
    try {
      const { object } = await this.rpc.core.getObject({ objectId: accountId, include: { content: true } });
      return normalizeSuiAddress(creditAccount.CreditAccount.parse(object.content).program_id);
    } catch (err: unknown) {
      if (err instanceof ObjectError && (err.reason === 'notFound' || err.reason === 'deleted')) {
        return null;
      }
      throw err;
    }
  }

  /** A budget shard's remaining points, read straight from the object. Throws if it can't be read. */
  async budgetShardRemaining(shardId: string): Promise<bigint> {
    const { object } = await this.rpc.core.getObject({ objectId: shardId, include: { content: true } });
    return BigInt(budgetShard.BudgetShard.parse(object.content).remaining);
  }

  async currentEpoch(): Promise<bigint> {
    const { systemState } = await this.rpc.core.getCurrentSystemState();
    return BigInt(systemState.epoch);
  }
}

/** Whether two Sui addresses or object ids are the same, however they are written. */
export function sameSuiAddress(a: string, b: string): boolean {
  return normalizeSuiAddress(a) === normalizeSuiAddress(b);
}

/** Decodes a `suiprivkey1...` string into a signer. Only ed25519 is supported today. */
export function signerFromPrivateKey(bech32PrivateKey: string): Ed25519Keypair {
  const decoded = decodeSuiPrivateKey(bech32PrivateKey);
  if (decoded.scheme !== 'ED25519') {
    throw new Error(`Unsupported key scheme "${decoded.scheme}"; only ed25519 issuer/admin keys are supported today.`);
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}
