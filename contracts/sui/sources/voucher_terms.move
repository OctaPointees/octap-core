/// A voucher's promise, frozen when it is published: nobody, including the
/// issuer that published it, can change it afterwards. A different offer is a
/// new `VoucherTerms`. The `terms` bytes are the merchant's own canonical JSON,
/// which this package stores without interpreting, so merchants keep full
/// freedom over a voucher's form. They must hold no personal data.
module octap::voucher_terms;

use octap::capabilities::{Self, IssuerCap};
use octap::program_control::ProgramControl;
use sui::event;

const EWrongProgram: u64 = 0;
const EEmptyTerms: u64 = 1;
const EInvalidWindow: u64 = 2;

public struct VoucherTerms has key {
    id: UID,
    program_id: ID,
    terms: vector<u8>,
    /// Zero when the voucher can only be granted, not claimed with points.
    points_cost: u64,
    /// Zero means no start limit.
    starts_at_ms: u64,
    /// Zero means it never expires.
    expires_at_ms: u64,
}

public struct VoucherTermsPublished has copy, drop {
    terms_id: ID,
    program_id: ID,
    /// The off-chain voucher this publishes, for correlating the event.
    reference: vector<u8>,
    points_cost: u64,
    starts_at_ms: u64,
    expires_at_ms: u64,
}

entry fun publish_terms(
    issuer: &IssuerCap,
    program: &ProgramControl,
    reference: vector<u8>,
    terms: vector<u8>,
    points_cost: u64,
    starts_at_ms: u64,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(capabilities::issuer_program_id(issuer) == object::id(program), EWrongProgram);
    assert!(!vector::is_empty(&terms), EEmptyTerms);
    assert!(expires_at_ms == 0 || expires_at_ms > starts_at_ms, EInvalidWindow);

    let voucher_terms = VoucherTerms {
        id: object::new(ctx),
        program_id: object::id(program),
        terms,
        points_cost,
        starts_at_ms,
        expires_at_ms,
    };
    event::emit(VoucherTermsPublished {
        terms_id: object::id(&voucher_terms),
        program_id: object::id(program),
        reference,
        points_cost,
        starts_at_ms,
        expires_at_ms,
    });
    transfer::freeze_object(voucher_terms);
}

public fun program_id(terms: &VoucherTerms): ID {
    terms.program_id
}

public fun points_cost(terms: &VoucherTerms): u64 {
    terms.points_cost
}

public fun terms(terms: &VoucherTerms): vector<u8> {
    terms.terms
}

public fun is_unexpired(terms: &VoucherTerms, now_ms: u64): bool {
    terms.expires_at_ms == 0 || now_ms < terms.expires_at_ms
}

/// Started and not yet expired.
public fun is_active(terms: &VoucherTerms, now_ms: u64): bool {
    now_ms >= terms.starts_at_ms && is_unexpired(terms, now_ms)
}
