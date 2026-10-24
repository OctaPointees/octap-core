/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Capability objects for the OctaP credit program. Capabilities carry no state
 * beyond the program they are scoped to; all business rules live in the modules
 * that consume them.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::capabilities';
export const AdminCap = new MoveStruct({ name: `${$moduleName}::AdminCap`, fields: {
        id: bcs.Address,
        program_id: bcs.Address
    } });
export const IssuerCap = new MoveStruct({ name: `${$moduleName}::IssuerCap`, fields: {
        id: bcs.Address,
        program_id: bcs.Address
    } });
export interface AdminProgramIdArguments {
    cap: RawTransactionArgument<string>;
}
export interface AdminProgramIdOptions {
    package?: string;
    arguments: AdminProgramIdArguments | [
        cap: RawTransactionArgument<string>
    ];
}
export function adminProgramId(options: AdminProgramIdOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capabilities',
        function: 'admin_program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IssuerProgramIdArguments {
    cap: RawTransactionArgument<string>;
}
export interface IssuerProgramIdOptions {
    package?: string;
    arguments: IssuerProgramIdArguments | [
        cap: RawTransactionArgument<string>
    ];
}
export function issuerProgramId(options: IssuerProgramIdOptions) {
    const packageAddress = options.package ?? '0x8ee8b8b9def794088090984737e5b33e46bcbe7c13d35dd5b7c4b36845e975ba';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["cap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'capabilities',
        function: 'issuer_program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}