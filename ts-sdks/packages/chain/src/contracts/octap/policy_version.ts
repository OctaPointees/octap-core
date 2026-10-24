/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * An immutable, versioned earn rule for one program. Publishing a new version
 * never edits an old one — `program_control::activate_policy` is the only thing
 * that changes which version is enforced, so history stays auditable.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::policy_version';
export const PolicyVersion = new MoveStruct({ name: `${$moduleName}::PolicyVersion`, fields: {
        id: bcs.Address,
        program_id: bcs.Address,
        version: bcs.u64(),
        /**
         * Credits earned per 10_000 units of purchase amount (basis points), e.g. 100 = 1
         * credit per 100 units spent.
         */
        earn_bps: bcs.u64(),
        /**
         * How long, in milliseconds from the moment of earning, a bucket of credits minted
         * under this policy stays spendable.
         */
        expiry_ms: bcs.u64()
    } });
export const PolicyPublished = new MoveStruct({ name: `${$moduleName}::PolicyPublished`, fields: {
        program_id: bcs.Address,
        policy_version_id: bcs.Address,
        version: bcs.u64(),
        earn_bps: bcs.u64(),
        expiry_ms: bcs.u64()
    } });
export interface PublishArguments {
    admin: RawTransactionArgument<string>;
    programId: RawTransactionArgument<string>;
    version: RawTransactionArgument<number | bigint>;
    earnBps: RawTransactionArgument<number | bigint>;
    expiryMs: RawTransactionArgument<number | bigint>;
}
export interface PublishOptions {
    package?: string;
    arguments: PublishArguments | [
        admin: RawTransactionArgument<string>,
        programId: RawTransactionArgument<string>,
        version: RawTransactionArgument<number | bigint>,
        earnBps: RawTransactionArgument<number | bigint>,
        expiryMs: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Publishes and permanently freezes a new policy version for `program_id`.
 * Freezing (rather than a shared, admin-writable object) is what makes "immutable
 * post-publish" an on-chain guarantee instead of a convention.
 */
export function publish(options: PublishOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'u64',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "programId", "version", "earnBps", "expiryMs"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'policy_version',
        function: 'publish',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ProgramIdArguments {
    policy: RawTransactionArgument<string>;
}
export interface ProgramIdOptions {
    package?: string;
    arguments: ProgramIdArguments | [
        policy: RawTransactionArgument<string>
    ];
}
export function programId(options: ProgramIdOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'policy_version',
        function: 'program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface VersionArguments {
    policy: RawTransactionArgument<string>;
}
export interface VersionOptions {
    package?: string;
    arguments: VersionArguments | [
        policy: RawTransactionArgument<string>
    ];
}
export function version(options: VersionOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'policy_version',
        function: 'version',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface EarnBpsArguments {
    policy: RawTransactionArgument<string>;
}
export interface EarnBpsOptions {
    package?: string;
    arguments: EarnBpsArguments | [
        policy: RawTransactionArgument<string>
    ];
}
export function earnBps(options: EarnBpsOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'policy_version',
        function: 'earn_bps',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpiryMsArguments {
    policy: RawTransactionArgument<string>;
}
export interface ExpiryMsOptions {
    package?: string;
    arguments: ExpiryMsArguments | [
        policy: RawTransactionArgument<string>
    ];
}
export function expiryMs(options: ExpiryMsOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'policy_version',
        function: 'expiry_ms',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}