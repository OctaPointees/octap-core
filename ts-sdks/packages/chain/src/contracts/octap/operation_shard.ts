/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * On-chain anti-replay for `credit_account::earn`. Every `operation_key` a program
 * has ever earned under is recorded in exactly one of the program's
 * `OperationShard`s, so a replayed key aborts on-chain even if it somehow got past
 * PostgreSQL's idempotency key.
 * 
 * Sharded rather than one shared table so that concurrent earns with different
 * keys mostly touch different shared objects instead of all contending on a single
 * hot one. Which shard owns a key is a pure function of the key
 * (`shard_index_for`), so a caller can't pick a fresh shard to slip a replay past
 * the check: passing any shard but the owning one aborts `EWrongShard`.
 * 
 * Shard index convention (the TS SDK's `operationShardIndex` must match this
 * byte-for-byte): `sha2_256(operation_key)`, first 8 bytes read as a big-endian
 * u64, mod `shard_count`.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as table from './deps/sui/table.js';
const $moduleName = 'octap::operation_shard';
export const OperationShard = new MoveStruct({ name: `${$moduleName}::OperationShard`, fields: {
        id: bcs.Address,
        program_id: bcs.Address,
        shard_index: bcs.u64(),
        shard_count: bcs.u64(),
        seen: table.Table
    } });
export const OperationShardCreated = new MoveStruct({ name: `${$moduleName}::OperationShardCreated`, fields: {
        program_id: bcs.Address,
        shard_id: bcs.Address,
        shard_index: bcs.u64(),
        shard_count: bcs.u64()
    } });
export interface CreateShardsArguments {
    admin: RawTransactionArgument<string>;
    programId: RawTransactionArgument<string>;
    shardCount: RawTransactionArgument<number | bigint>;
}
export interface CreateShardsOptions {
    package?: string;
    arguments: CreateShardsArguments | [
        admin: RawTransactionArgument<string>,
        programId: RawTransactionArgument<string>,
        shardCount: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Creates and shares `shard_count` shards for `program_id`, returning their ids in
 * shard-index order so a provisioning transaction (or a test) can map index ->
 * object id without scanning events.
 */
export function createShards(options: CreateShardsOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "programId", "shardCount"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
        function: 'create_shards',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CheckAndRecordArguments {
    shard: RawTransactionArgument<string>;
    programId: RawTransactionArgument<string>;
    operationKey: RawTransactionArgument<Array<number>>;
}
export interface CheckAndRecordOptions {
    package?: string;
    arguments: CheckAndRecordArguments | [
        shard: RawTransactionArgument<string>,
        programId: RawTransactionArgument<string>,
        operationKey: RawTransactionArgument<Array<number>>
    ];
}
/**
 * Aborts unless `shard` is `program_id`'s owning shard for `operation_key` and the
 * key has never been recorded; then records it.
 */
export function checkAndRecord(options: CheckAndRecordOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["shard", "programId", "operationKey"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
        function: 'check_and_record',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ShardIndexForArguments {
    operationKey: RawTransactionArgument<Array<number>>;
    shardCount: RawTransactionArgument<number | bigint>;
}
export interface ShardIndexForOptions {
    package?: string;
    arguments: ShardIndexForArguments | [
        operationKey: RawTransactionArgument<Array<number>>,
        shardCount: RawTransactionArgument<number | bigint>
    ];
}
/**
 * The shard that owns `operation_key` out of `shard_count`. See the module doc for
 * the exact byte-order convention.
 */
export function shardIndexFor(options: ShardIndexForOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        'vector<u8>',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["operationKey", "shardCount"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
        function: 'shard_index_for',
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
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
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
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
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
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["shard"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
        function: 'shard_count',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface HasSeenArguments {
    shard: RawTransactionArgument<string>;
    operationKey: RawTransactionArgument<Array<number>>;
}
export interface HasSeenOptions {
    package?: string;
    arguments: HasSeenArguments | [
        shard: RawTransactionArgument<string>,
        operationKey: RawTransactionArgument<Array<number>>
    ];
}
export function hasSeen(options: HasSeenOptions) {
    const packageAddress = options.package ?? '0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392';
    const argumentsTypes = [
        null,
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["shard", "operationKey"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'operation_shard',
        function: 'has_seen',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}