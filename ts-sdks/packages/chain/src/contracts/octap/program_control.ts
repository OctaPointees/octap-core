/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * `ProgramControl` is the shared root object for one organization's credit
 * program: it is the on-chain identity every capability, policy, and credit
 * account is checked against, and the single switch that pauses a program or
 * rotates its active policy. Program admins invoke this module directly; issuers
 * and beneficiaries only ever read it.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::program_control';
export const ProgramControl = new MoveStruct({ name: `${$moduleName}::ProgramControl`, fields: {
        id: bcs.Address,
        active_policy_version: bcs.option(bcs.Address),
        paused: bcs.bool()
    } });
export const ProgramCreated = new MoveStruct({ name: `${$moduleName}::ProgramCreated`, fields: {
        program_id: bcs.Address,
        admin_cap_id: bcs.Address
    } });
export const PolicyActivated = new MoveStruct({ name: `${$moduleName}::PolicyActivated`, fields: {
        program_id: bcs.Address,
        policy_version_id: bcs.Address
    } });
export const ProgramPauseToggled = new MoveStruct({ name: `${$moduleName}::ProgramPauseToggled`, fields: {
        program_id: bcs.Address,
        paused: bcs.bool()
    } });
export const IssuerCapIssued = new MoveStruct({ name: `${$moduleName}::IssuerCapIssued`, fields: {
        program_id: bcs.Address,
        issuer_cap_id: bcs.Address,
        recipient: bcs.Address
    } });
export interface CreateProgramOptions {
    package?: string;
    arguments?: [
    ];
}
/**
 * Creates a new program and mints its `AdminCap` to the caller. The program starts
 * paused-off but with no active policy: `earn` aborts until `activate_policy` is
 * called, so a program can be fully provisioned (policy published, reviewed)
 * before it can move credits.
 */
export function createProgram(options: CreateProgramOptions = {}) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'create_program',
    });
}
export interface CreateProgramEntryOptions {
    package?: string;
    arguments?: [
    ];
}
export function createProgramEntry(options: CreateProgramEntryOptions = {}) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'create_program_entry',
    });
}
export interface AssertSameProgramArguments {
    program: RawTransactionArgument<string>;
    programId: RawTransactionArgument<string>;
}
export interface AssertSameProgramOptions {
    package?: string;
    arguments: AssertSameProgramArguments | [
        program: RawTransactionArgument<string>,
        programId: RawTransactionArgument<string>
    ];
}
export function assertSameProgram(options: AssertSameProgramOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        '0x2::object::ID'
    ] satisfies (string | null)[];
    const parameterNames = ["program", "programId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'assert_same_program',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface AssertActiveArguments {
    program: RawTransactionArgument<string>;
}
export interface AssertActiveOptions {
    package?: string;
    arguments: AssertActiveArguments | [
        program: RawTransactionArgument<string>
    ];
}
export function assertActive(options: AssertActiveOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["program"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'assert_active',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface AssertPolicyActiveArguments {
    program: RawTransactionArgument<string>;
    policy: RawTransactionArgument<string>;
}
export interface AssertPolicyActiveOptions {
    package?: string;
    arguments: AssertPolicyActiveArguments | [
        program: RawTransactionArgument<string>,
        policy: RawTransactionArgument<string>
    ];
}
/**
 * Aborts unless `policy` is both scoped to `program` and currently the program's
 * active policy version — the on-chain enforcement behind "policy must be active,
 * not paused, and valid" (registration invariant).
 */
export function assertPolicyActive(options: AssertPolicyActiveOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["program", "policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'assert_policy_active',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ActivatePolicyArguments {
    admin: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    policy: RawTransactionArgument<string>;
}
export interface ActivatePolicyOptions {
    package?: string;
    arguments: ActivatePolicyArguments | [
        admin: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        policy: RawTransactionArgument<string>
    ];
}
export function activatePolicy(options: ActivatePolicyOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "program", "policy"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'activate_policy',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SetPausedArguments {
    admin: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    paused: RawTransactionArgument<boolean>;
}
export interface SetPausedOptions {
    package?: string;
    arguments: SetPausedArguments | [
        admin: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        paused: RawTransactionArgument<boolean>
    ];
}
export function setPaused(options: SetPausedOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        null,
        'bool'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "program", "paused"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'set_paused',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IssueCapArguments {
    admin: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    recipient: RawTransactionArgument<string>;
}
export interface IssueCapOptions {
    package?: string;
    arguments: IssueCapArguments | [
        admin: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        recipient: RawTransactionArgument<string>
    ];
}
/**
 * Mints a new `IssuerCap` for this program and sends it to `recipient` (the
 * address backing the service signer that will call `earn`).
 */
export function issueCap(options: IssueCapOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null,
        null,
        'address'
    ] satisfies (string | null)[];
    const parameterNames = ["admin", "program", "recipient"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'program_control',
        function: 'issue_cap',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}