/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * A program's total issuance budget, split across `shard_count` shared objects so
 * concurrent earns don't all contend on one balance. Each shard is debited
 * independently and can never go negative; a shard running dry does not borrow
 * from its siblings.
 * 
 * Shard selection deliberately reuses `operation_shard`'s index for the same
 * `operation_key` instead of load-balancing budget shards on their own: it keeps
 * the caller to one hash computation. That's a documented simplification — it
 * means a program's operation and budget shard counts should match, and a hot key
 * range drains its budget shard first.
 * 
 * A drained shard is refilled by the program's `AdminCap` holder with `top_up`.
 * `debit` and `refund` are `public(package)`: only
 * `credit_account::earn`/`reverse_earn` move budget, since a public `&mut`
 * function on a shared shard would let anyone drain it.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::budget_shard';
export const BudgetShard = new MoveStruct({ name: `${$moduleName}::BudgetShard`, fields: {
        id: bcs.Address,
        program_id: bcs.Address,
        shard_index: bcs.u64(),
        shard_count: bcs.u64(),
        remaining: bcs.u64()
    } });
export const BudgetShardCreated = new MoveStruct({ name: `${$moduleName}::BudgetShardCreated`, fields: {
        program_id: bcs.Address,
        shard_id: bcs.Address,
        shard_index: bcs.u64(),
        shard_count: bcs.u64(),
        allocated: bcs.u64()
    } });
export const BudgetDebited = new MoveStruct({ name: `${$moduleName}::BudgetDebited`, fields: {
        program_id: bcs.Address,
        shard_id: bcs.Address,
        amount: bcs.u64(),
        remaining: bcs.u64()
    } });
export const BudgetRefunded = new MoveStruct({ name: `${$moduleName}::BudgetRefunded`, fields: {
        program_id: bcs.Address,
        shard_id: bcs.Address,
        amount: bcs.u64(),
        remaining: bcs.u64()
    } });
export const BudgetToppedUp = new MoveStruct({ name: `${$moduleName}::BudgetToppedUp`, fields: {
        program_id: bcs.Address,
        shard_id: bcs.Address,
        amount: bcs.u64(),
        remaining: bcs.u64()
    } });
export interface CreateShardsArguments {
    admin: RawTransactionArgument<string>;
    programId: RawTransactionArgument<string>;
    totalBudget: RawTransactionArgument<number | bigint>;
    shardCount: RawTransactionArgument<number | bigint>;
}
export interface CreateShardsOptions {
    package?: string;
    arguments: CreateShardsArguments | [
        admin: RawTransactionArgument<string>,
        programId: RawTransactionArgument<string>,
        totalBudget: RawTransactionArgument<number | bigint>,
        shardCount: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Creates and shares `shard_count` shards for `program_id`, splitting
 * `total_budget` evenly with the division remainder going to shard 0. Returns the
 * shard ids in shard-index order.
 */
export function createShards(options: CreateShardsOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "programId", "totalBudget", "shardCount"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'create_shards',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface TopUpArguments {
    admin: RawTransactionArgument<string>;
    shard: RawTransactionArgument<string>;
    amount: RawTransactionArgument<number | bigint>;
}
export interface TopUpOptions {
    package?: string;
    arguments: TopUpArguments | [
        admin: RawTransactionArgument<string>,
        shard: RawTransactionArgument<string>,
        amount: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Adds `amount` to one shard's remaining budget. Only the program's `AdminCap` can
 * do this, and only for its own program's shards; the amount isn't redistributed
 * across siblings, so a caller refilling a multi-shard program tops up each shard
 * it wants refilled.
 */
export function topUp(options: TopUpOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "shard", "amount"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'top_up',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ProgramIdArguments {
    shard: RawTransactionArgument<string>;
}
export interface ProgramIdOptions {
    package?: string;
    arguments: ProgramIdArguments | [
        shard: RawTransactionArgument<string>
    ];
}
export function programId(options: ProgramIdOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ShardIndexArguments {
    shard: RawTransactionArgument<string>;
}
export interface ShardIndexOptions {
    package?: string;
    arguments: ShardIndexArguments | [
        shard: RawTransactionArgument<string>
    ];
}
export function shardIndex(options: ShardIndexOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'shard_index',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ShardCountArguments {
    shard: RawTransactionArgument<string>;
}
export interface ShardCountOptions {
    package?: string;
    arguments: ShardCountArguments | [
        shard: RawTransactionArgument<string>
    ];
}
export function shardCount(options: ShardCountOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'shard_count',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface RemainingArguments {
    shard: RawTransactionArgument<string>;
}
export interface RemainingOptions {
    package?: string;
    arguments: RemainingArguments | [
        shard: RawTransactionArgument<string>
    ];
}
export function remaining(options: RemainingOptions) {
    const packageAddress = options.package ?? '0x0e7f5c0b716781d15f2675079b5a169e307ad6ba652a4c5f2fbe67d6b594bd9b';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'budget_shard',
        function: 'remaining',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}