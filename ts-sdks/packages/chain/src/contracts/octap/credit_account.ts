/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * `CreditAccount` is the on-chain source of truth for one beneficiary's spendable
 * credits under one program. Balances are never a single integer: they are a set
 * of expiry buckets, consumed nearest-expiry first, because the business rule is
 * "use-it-or-lose-it by date," not "spend any credit you own."
 * 
 * Anti-replay for `operation_key` is enforced on-chain by `earn` via the program's
 * `OperationShard`s, on top of PostgreSQL's idempotency key, and every earn is
 * debited from the program's `BudgetShard` for the same key. `operation_key` is
 * also emitted on `CreditEarned` so the event can be correlated with the off-chain
 * command that caused it.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::credit_account';
export const Bucket = new MoveStruct({ name: `${$moduleName}::Bucket`, fields: {
        expires_at_ms: bcs.u64(),
        amount: bcs.u64()
    } });
export const CreditAccount = new MoveStruct({ name: `${$moduleName}::CreditAccount`, fields: {
        id: bcs.Address,
        program_id: bcs.Address,
        beneficiary: bcs.Address,
        buckets: bcs.vector(Bucket),
        lifetime_earned: bcs.u64(),
        lifetime_redeemed: bcs.u64()
    } });
export const CreditAccountOpened = new MoveStruct({ name: `${$moduleName}::CreditAccountOpened`, fields: {
        account_id: bcs.Address,
        program_id: bcs.Address,
        beneficiary: bcs.Address
    } });
export const CreditEarned = new MoveStruct({ name: `${$moduleName}::CreditEarned`, fields: {
        account_id: bcs.Address,
        program_id: bcs.Address,
        beneficiary: bcs.Address,
        amount: bcs.u64(),
        bucket_expires_at_ms: bcs.u64(),
        operation_key: bcs.vector(bcs.u8())
    } });
export const CreditRedeemed = new MoveStruct({ name: `${$moduleName}::CreditRedeemed`, fields: {
        account_id: bcs.Address,
        program_id: bcs.Address,
        beneficiary: bcs.Address,
        amount: bcs.u64(),
        reference: bcs.vector(bcs.u8())
    } });
export const CreditExpired = new MoveStruct({ name: `${$moduleName}::CreditExpired`, fields: {
        account_id: bcs.Address,
        program_id: bcs.Address,
        amount: bcs.u64()
    } });
export interface OpenAccountArguments {
    issuer: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    beneficiary: RawTransactionArgument<string>;
}
export interface OpenAccountOptions {
    package?: string;
    arguments: OpenAccountArguments | [
        issuer: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        beneficiary: RawTransactionArgument<string>
    ];
}
/**
 * Opens a new shared `CreditAccount` for `beneficiary` under `program`. Gated by
 * `IssuerCap` (rather than left permissionless) so that account creation follows
 * the same enrollment the organization already runs off-chain, instead of letting
 * anyone spam shared objects.
 */
export function openAccount(options: OpenAccountOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        null,
        'address'
    ] satisfies (string | null)[];
    const parameterNames = ["issuer", "program", "beneficiary"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'open_account',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface EarnArguments {
    issuer: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    policy: RawTransactionArgument<string>;
    account: RawTransactionArgument<string>;
    operationShard: RawTransactionArgument<string>;
    budgetShard: RawTransactionArgument<string>;
    purchaseAmount: RawTransactionArgument<number | bigint>;
    operationKey: RawTransactionArgument<Array<number>>;
}
export interface EarnOptions {
    package?: string;
    arguments: EarnArguments | [
        issuer: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        policy: RawTransactionArgument<string>,
        account: RawTransactionArgument<string>,
        operationShard: RawTransactionArgument<string>,
        budgetShard: RawTransactionArgument<string>,
        purchaseAmount: RawTransactionArgument<number | bigint>,
        operationKey: RawTransactionArgument<Array<number>>
    ];
}
/**
 * Mints a new expiry bucket of credits computed from the program's active policy.
 * The amount is derived on-chain from `purchase_amount` and `policy`'s earn ratio
 * rather than trusted from the caller, which is what makes the policy an enforced
 * rule instead of a suggestion.
 *
 * `operation_shard` and `budget_shard` must be the program's shards that own
 * `operation_key` (see `operation_shard::shard_index_for`): a replayed key aborts
 * `operation_shard::EDuplicateOperation`, and an earn that would overdraw its
 * budget shard aborts `budget_shard::EBudgetExceeded`.
 */
export function earn(options: EarnOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        null,
        null,
        'u64',
        'vector<u8>',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["issuer", "program", "policy", "account", "operationShard", "budgetShard", "purchaseAmount", "operationKey"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'earn',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface RedeemArguments {
    account: RawTransactionArgument<string>;
    cost: RawTransactionArgument<number | bigint>;
    reference: RawTransactionArgument<Array<number>>;
}
export interface RedeemOptions {
    package?: string;
    arguments: RedeemArguments | [
        account: RawTransactionArgument<string>,
        cost: RawTransactionArgument<number | bigint>,
        reference: RawTransactionArgument<Array<number>>
    ];
}
/**
 * Debits `cost` credits, consuming the nearest-to-expiry bucket(s) first. Requires
 * the beneficiary's own signature (`sender == beneficiary`): there is no path for
 * an organization or admin to spend on a member's behalf, matching the
 * non-transferable, consent-gated redemption rule.
 */
export function redeem(options: RedeemOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        'u64',
        'vector<u8>',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["account", "cost", "reference"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'redeem',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SpendableArguments {
    account: RawTransactionArgument<string>;
}
export interface SpendableOptions {
    package?: string;
    arguments: SpendableArguments | [
        account: RawTransactionArgument<string>
    ];
}
/**
 * Read-only spendable total as of `clock`, for API/indexer reconciliation against
 * the PostgreSQL projection without needing a transaction.
 */
export function spendable(options: SpendableOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["account"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'spendable',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface BeneficiaryArguments {
    account: RawTransactionArgument<string>;
}
export interface BeneficiaryOptions {
    package?: string;
    arguments: BeneficiaryArguments | [
        account: RawTransactionArgument<string>
    ];
}
export function beneficiary(options: BeneficiaryOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["account"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'beneficiary',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ProgramIdArguments {
    account: RawTransactionArgument<string>;
}
export interface ProgramIdOptions {
    package?: string;
    arguments: ProgramIdArguments | [
        account: RawTransactionArgument<string>
    ];
}
export function programId(options: ProgramIdOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["account"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'credit_account',
        function: 'program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}