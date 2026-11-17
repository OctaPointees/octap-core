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
const EInvalidUseDuration: u64 = 3;

/// How long a voucher must stay usable after it is claimed or granted, so a
/// customer never spends points on a voucher that expires before they can use it.
const MIN_USE_WINDOW_MS: u64 = 86_400_000;
/// The longest use duration a voucher can promise: 3650 days. It also keeps
/// `issued_at_ms + use_duration_ms` far from overflowing.
const MAX_USE_DURATION_MS: u64 = 315_360_000_000;

public struct VoucherTerms has key {
    id: UID,
    program_id: ID,
    terms: vector<u8>,
    /// Zero when the voucher can only be granted, not claimed with points.
    points_cost: u64,
    /// Zero means no start limit.
    starts_at_ms: u64,
    /// Zero means it never expires. With a use duration, it is the claim window's
    /// close and the cap on every customer's deadline.
    expires_at_ms: u64,
    /// How long each customer's voucher stays usable from when it was issued to
    /// them, capped by `expires_at_ms`. Zero means every voucher expires at
    /// `expires_at_ms`.
    use_duration_ms: u64,
}

public struct VoucherTermsPublished has copy, drop {
    terms_id: ID,
    program_id: ID,
    /// The off-chain voucher this publishes, for correlating the event.
    reference: vector<u8>,
    points_cost: u64,
    starts_at_ms: u64,
    expires_at_ms: u64,
    use_duration_ms: u64,
}

entry fun publish_terms(
    issuer: &IssuerCap,
    program: &ProgramControl,
    reference: vector<u8>,
    terms: vector<u8>,
    points_cost: u64,
    starts_at_ms: u64,
    expires_at_ms: u64,
    use_duration_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(capabilities::issuer_program_id(issuer) == object::id(program), EWrongProgram);
    assert!(!vector::is_empty(&terms), EEmptyTerms);
    assert!(expires_at_ms == 0 || expires_at_ms > starts_at_ms, EInvalidWindow);
    assert!(
        use_duration_ms == 0 || (use_duration_ms >= MIN_USE_WINDOW_MS && use_duration_ms <= MAX_USE_DURATION_MS),
        EInvalidUseDuration,
    );

    let voucher_terms = VoucherTerms {
        id: object::new(ctx),
        program_id: object::id(program),
        terms,
        points_cost,
        starts_at_ms,
        expires_at_ms,
        use_duration_ms,
    };
    event::emit(VoucherTermsPublished {
        terms_id: object::id(&voucher_terms),
        program_id: object::id(program),
        reference,
        points_cost,
        starts_at_ms,
        expires_at_ms,
        use_duration_ms,
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

public fun use_duration_ms(terms: &VoucherTerms): u64 {
    terms.use_duration_ms
}

/// When a voucher issued at `issued_at_ms` stops being usable: the earlier of
/// `issued_at_ms + use_duration_ms` and `expires_at_ms`. Zero means never.
public fun use_deadline_ms(terms: &VoucherTerms, issued_at_ms: u64): u64 {
    if (terms.use_duration_ms == 0) return terms.expires_at_ms;
    let own = issued_at_ms + terms.use_duration_ms;
    if (terms.expires_at_ms == 0 || own < terms.expires_at_ms) own else terms.expires_at_ms
}

/// Whether a voucher issued at `issued_at_ms` can still be used at `now_ms`.
public fun is_usable(terms: &VoucherTerms, issued_at_ms: u64, now_ms: u64): bool {
    let deadline = use_deadline_ms(terms, issued_at_ms);
    deadline == 0 || now_ms < deadline
}

/// Started, and a voucher issued now stays usable for at least
/// `MIN_USE_WINDOW_MS`: `min(now + use_duration, expires_at) - now`.
public fun is_issuable(terms: &VoucherTerms, now_ms: u64): bool {
    if (now_ms < terms.starts_at_ms) return false;
    let deadline = use_deadline_ms(terms, now_ms);
    deadline == 0 || now_ms + MIN_USE_WINDOW_MS <= deadline
}
