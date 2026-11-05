/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * A voucher's promise, frozen when it is published: nobody, including the issuer
 * that published it, can change it afterwards. A different offer is a new
 * `VoucherTerms`. The `terms` bytes are the merchant's own canonical JSON, which
 * this package stores without interpreting, so merchants keep full freedom over a
 * voucher's form. They must hold no personal data.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = 'octap::voucher_terms';
export const VoucherTerms = new MoveStruct({ name: `${$moduleName}::VoucherTerms`, fields: {
        id: bcs.Address,
        program_id: bcs.Address,
        terms: bcs.vector(bcs.u8()),
        /** Zero when the voucher can only be granted, not claimed with points. */
        points_cost: bcs.u64(),
        /** Zero means no start limit. */
        starts_at_ms: bcs.u64(),
        /** Zero means it never expires. */
        expires_at_ms: bcs.u64()
    } });
export const VoucherTermsPublished = new MoveStruct({ name: `${$moduleName}::VoucherTermsPublished`, fields: {
        terms_id: bcs.Address,
        program_id: bcs.Address,
        /** The off-chain voucher this publishes, for correlating the event. */
        reference: bcs.vector(bcs.u8()),
        points_cost: bcs.u64(),
        starts_at_ms: bcs.u64(),
        expires_at_ms: bcs.u64()
    } });
export interface PublishTermsArguments {
    issuer: RawTransactionArgument<string>;
    program: RawTransactionArgument<string>;
    reference: RawTransactionArgument<Array<number>>;
    terms: RawTransactionArgument<Array<number>>;
    pointsCost: RawTransactionArgument<number | bigint>;
    startsAtMs: RawTransactionArgument<number | bigint>;
    expiresAtMs: RawTransactionArgument<number | bigint>;
}
export interface PublishTermsOptions {
    package?: string;
    arguments: PublishTermsArguments | [
        issuer: RawTransactionArgument<string>,
        program: RawTransactionArgument<string>,
        reference: RawTransactionArgument<Array<number>>,
        terms: RawTransactionArgument<Array<number>>,
        pointsCost: RawTransactionArgument<number | bigint>,
        startsAtMs: RawTransactionArgument<number | bigint>,
        expiresAtMs: RawTransactionArgument<number | bigint>
    ];
}
export function publishTerms(options: PublishTermsOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null,
        null,
        'vector<u8>',
        'vector<u8>',
        'u64',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["issuer", "program", "reference", "terms", "pointsCost", "startsAtMs", "expiresAtMs"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'publish_terms',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ProgramIdArguments {
    terms: RawTransactionArgument<string>;
}
export interface ProgramIdOptions {
    package?: string;
    arguments: ProgramIdArguments | [
        terms: RawTransactionArgument<string>
    ];
}
export function programId(options: ProgramIdOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["terms"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'program_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface PointsCostArguments {
    terms: RawTransactionArgument<string>;
}
export interface PointsCostOptions {
    package?: string;
    arguments: PointsCostArguments | [
        terms: RawTransactionArgument<string>
    ];
}
export function pointsCost(options: PointsCostOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["terms"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'points_cost',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface TermsArguments {
    terms: RawTransactionArgument<string>;
}
export interface TermsOptions {
    package?: string;
    arguments: TermsArguments | [
        terms: RawTransactionArgument<string>
    ];
}
export function terms(options: TermsOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["terms"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'terms',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsUnexpiredArguments {
    terms: RawTransactionArgument<string>;
    nowMs: RawTransactionArgument<number | bigint>;
}
export interface IsUnexpiredOptions {
    package?: string;
    arguments: IsUnexpiredArguments | [
        terms: RawTransactionArgument<string>,
        nowMs: RawTransactionArgument<number | bigint>
    ];
}
export function isUnexpired(options: IsUnexpiredOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["terms", "nowMs"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'is_unexpired',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsIssuableArguments {
    terms: RawTransactionArgument<string>;
    nowMs: RawTransactionArgument<number | bigint>;
}
export interface IsIssuableOptions {
    package?: string;
    arguments: IsIssuableArguments | [
        terms: RawTransactionArgument<string>,
        nowMs: RawTransactionArgument<number | bigint>
    ];
}
/** Started, and usable for at least `MIN_USE_WINDOW_MS` more. */
export function isIssuable(options: IsIssuableOptions) {
    const packageAddress = options.package ?? '0x775796f068175941f7bc20375760b9e158059c908b764cf8324d1390f3561a23';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["terms", "nowMs"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'voucher_terms',
        function: 'is_issuable',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}