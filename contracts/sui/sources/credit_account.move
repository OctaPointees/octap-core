/// `CreditAccount` is the on-chain source of truth for one beneficiary's
/// spendable credits under one program. Balances are never a single
/// integer: they are a set of expiry buckets, consumed nearest-expiry
/// first, because the business rule is "use-it-or-lose-it by date," not
/// "spend any credit you own."
///
/// Anti-replay for `operation_key` is enforced on-chain by `earn` via the
/// program's `OperationShard`s, on top of PostgreSQL's idempotency key, and
/// every earn is debited from the program's `BudgetShard` for the same key.
/// `operation_key` is also emitted on `CreditEarned` so the event can be
/// correlated with the off-chain command that caused it.
///
/// Reversals are issuer operations, separate from the earn/redeem they
/// undo: `reverse_earn` removes exactly the bucket one earn created (and
/// refunds its budget), aborting if that bucket was already partly spent or
/// expired instead of silently clawing back less; `reverse_redeem` gives a
/// redemption's credits back as a non-expiring balance. Each original can be
/// reversed at most once, enforced here, not only in PostgreSQL.
///
/// A customer's voucher is a record in this account, not an object they hold:
/// it cannot be transferred, and `use_voucher` is the only way to mark it used.
/// Its promise lives in the frozen `VoucherTerms` it points to.
module octap::credit_account;

use octap::budget_shard::{Self, BudgetShard};
use octap::capabilities::{Self, IssuerCap};
use octap::operation_shard::{Self, OperationShard};
use octap::program_control::{Self, ProgramControl};
use octap::policy_version::{Self, PolicyVersion};
use octap::voucher_terms::{Self, VoucherTerms};
use sui::clock::{Self, Clock};
use sui::event;
use sui::table::{Self, Table};

const EWrongProgram: u64 = 0;
const ENotBeneficiary: u64 = 1;
const EZeroAmount: u64 = 2;
const EInsufficientBalance: u64 = 3;
const EZeroEarn: u64 = 4;
const EWrongAccount: u64 = 5;
const EBucketUnavailable: u64 = 6;
const EUnknownRedemption: u64 = 7;
const ERedemptionAlreadyReversed: u64 = 8;
const EDuplicateRedemption: u64 = 9;
const EDuplicateVoucher: u64 = 10;
const EUnknownVoucher: u64 = 11;
const EVoucherNotAvailable: u64 = 12;
const EVoucherNotActive: u64 = 13;
const EWrongVoucherTerms: u64 = 14;
const EVoucherNotPaid: u64 = 15;
const EVoucherStillAvailable: u64 = 16;

const VOUCHER_AVAILABLE: u8 = 0;
const VOUCHER_USED: u8 = 1;
const VOUCHER_CANCELLED: u8 = 2;

public struct Bucket has store, drop, copy {
    expires_at_ms: u64,
    amount: u64,
    /// Unique per account, assigned at `earn`, so `reverse_earn` can find
    /// the one bucket its earn created even among same-expiry buckets.
    seq: u64,
}

/// One `redeem`, keyed by its `reference`, so it can be reversed exactly once.
public struct Redemption has store, drop {
    amount: u64,
    reversed: bool,
}

/// One customer's voucher, keyed by its off-chain reference.
public struct VoucherRecord has store, drop {
    terms_id: ID,
    /// Zero for a granted voucher, which has nothing to refund.
    points_paid: u64,
    status: u8,
    issued_at_ms: u64,
}

public struct CreditAccount has key {
    id: UID,
    program_id: ID,
    beneficiary: address,
    buckets: vector<Bucket>,
    next_bucket_seq: u64,
    /// Credits given back by `reverse_redeem`: they never expire, and
    /// `redeem` spends them only after every live bucket.
    non_expiring: u64,
    /// `reference` of every `redeem` -> what it spent.
    redemptions: Table<vector<u8>, Redemption>,
    /// `reference` of every voucher -> its record.
    vouchers: Table<vector<u8>, VoucherRecord>,
    lifetime_earned: u64,
    lifetime_redeemed: u64,
}

public struct CreditAccountOpened has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
}

public struct CreditEarned has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    amount: u64,
    bucket_expires_at_ms: u64,
    operation_key: vector<u8>,
}

public struct CreditRedeemed has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    amount: u64,
    reference: vector<u8>,
}

public struct CreditEarnReversed has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    amount: u64,
    operation_key: vector<u8>,
}

public struct CreditRedeemReversed has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    amount: u64,
    reference: vector<u8>,
}

public struct VoucherClaimed has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    terms_id: ID,
    points_paid: u64,
    reference: vector<u8>,
}

public struct VoucherGranted has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    terms_id: ID,
    reference: vector<u8>,
}

public struct VoucherUsed has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    terms_id: ID,
    reference: vector<u8>,
}

public struct VoucherCancelled has copy, drop {
    account_id: ID,
    program_id: ID,
    beneficiary: address,
    terms_id: ID,
    points_refunded: u64,
    reference: vector<u8>,
}

public struct CreditExpired has copy, drop {
    account_id: ID,
    program_id: ID,
    amount: u64,
}

/// Opens a new shared `CreditAccount` for `beneficiary` under `program`.
/// Gated by `IssuerCap` (rather than left permissionless) so that account
/// creation follows the same enrollment the organization already runs
/// off-chain, instead of letting anyone spam shared objects.
entry fun open_account(issuer: &IssuerCap, program: &ProgramControl, beneficiary: address, ctx: &mut TxContext) {
    assert!(capabilities::issuer_program_id(issuer) == object::id(program), EWrongProgram);

    let account = CreditAccount {
        id: object::new(ctx),
        program_id: object::id(program),
        beneficiary,
        buckets: vector[],
        next_bucket_seq: 0,
        non_expiring: 0,
        redemptions: table::new(ctx),
        vouchers: table::new(ctx),
        lifetime_earned: 0,
        lifetime_redeemed: 0,
    };
    event::emit(CreditAccountOpened {
        account_id: object::id(&account),
        program_id: object::id(program),
        beneficiary,
    });
    transfer::share_object(account);
}

/// Mints a new expiry bucket of credits computed from the program's
/// active policy. The amount is derived on-chain from `purchase_amount`
/// and `policy`'s earn ratio rather than trusted from the caller, which
/// is what makes the policy an enforced rule instead of a suggestion.
///
/// `operation_shard` and `budget_shard` must be the program's shards that
/// own `operation_key` (see `operation_shard::shard_index_for`): a replayed
/// key aborts `operation_shard::EDuplicateOperation`, and an earn that
/// would overdraw its budget shard aborts `budget_shard::EBudgetExceeded`.
entry fun earn(
    issuer: &IssuerCap,
    program: &ProgramControl,
    policy: &PolicyVersion,
    account: &mut CreditAccount,
    operation_shard: &mut OperationShard,
    budget_shard: &mut BudgetShard,
    purchase_amount: u64,
    operation_key: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let _ = ctx;
    assert!(capabilities::issuer_program_id(issuer) == object::id(program), EWrongProgram);
    assert!(account.program_id == object::id(program), EWrongProgram);
    program_control::assert_policy_active(program, policy);

    let amount = (((purchase_amount as u128) * (policy_version::earn_bps(policy) as u128)) / 10_000) as u64;
    assert!(amount > 0, EZeroEarn);

    let seq = account.next_bucket_seq;
    operation_shard::check_and_record(
        operation_shard,
        account.program_id,
        copy operation_key,
        object::id(account),
        amount,
        seq,
    );
    budget_shard::debit(budget_shard, account.program_id, &operation_key, amount);

    let expires_at_ms = clock::timestamp_ms(clock) + policy_version::expiry_ms(policy);
    vector::push_back(&mut account.buckets, Bucket { expires_at_ms, amount, seq });
    account.next_bucket_seq = seq + 1;
    account.lifetime_earned = account.lifetime_earned + amount;

    event::emit(CreditEarned {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        amount,
        bucket_expires_at_ms: expires_at_ms,
        operation_key,
    });
}

/// Debits `cost` credits, consuming the nearest-to-expiry bucket(s) first
/// and the non-expiring balance last. Requires the beneficiary's own
/// signature (`sender == beneficiary`): there is no path for an
/// organization or admin to spend on a member's behalf, matching the
/// non-transferable, consent-gated redemption rule. `reference` must be new
/// to this account (`EDuplicateRedemption`): it is what `reverse_redeem`
/// later names.
entry fun redeem(account: &mut CreditAccount, cost: u64, reference: vector<u8>, clock: &Clock, ctx: &TxContext) {
    assert!(tx_context::sender(ctx) == account.beneficiary, ENotBeneficiary);
    debit(account, cost, reference, clock);
}

/// Spends the terms' points and records the voucher in one transaction, so a
/// customer never pays without holding the voucher. The price comes from the
/// frozen terms, not the caller. `reference` also names the debit, so
/// `CreditRedeemed` and `reverse_redeem` work as they do for `redeem`.
entry fun claim_voucher(
    account: &mut CreditAccount,
    terms: &VoucherTerms,
    reference: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tx_context::sender(ctx) == account.beneficiary, ENotBeneficiary);
    assert_terms_issuable(account, terms, clock);
    let points_paid = voucher_terms::points_cost(terms);
    assert!(!table::contains(&account.vouchers, reference), EDuplicateVoucher);

    debit(account, points_paid, copy reference, clock);
    table::add(
        &mut account.vouchers,
        copy reference,
        VoucherRecord {
            terms_id: object::id(terms),
            points_paid,
            status: VOUCHER_AVAILABLE,
            issued_at_ms: clock::timestamp_ms(clock),
        },
    );
    event::emit(VoucherClaimed {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        terms_id: object::id(terms),
        points_paid,
        reference,
    });
}

/// Gives the customer a voucher without spending their points, so it needs no
/// customer signature. Only using it does.
entry fun grant_voucher(
    issuer: &IssuerCap,
    account: &mut CreditAccount,
    terms: &VoucherTerms,
    reference: vector<u8>,
    clock: &Clock,
    _ctx: &TxContext,
) {
    assert!(capabilities::issuer_program_id(issuer) == account.program_id, EWrongProgram);
    assert_terms_issuable(account, terms, clock);
    assert!(!table::contains(&account.vouchers, reference), EDuplicateVoucher);

    table::add(
        &mut account.vouchers,
        copy reference,
        VoucherRecord {
            terms_id: object::id(terms),
            points_paid: 0,
            status: VOUCHER_AVAILABLE,
            issued_at_ms: clock::timestamp_ms(clock),
        },
    );
    event::emit(VoucherGranted {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        terms_id: object::id(terms),
        reference,
    });
}

/// Marks the voucher used. Requires the beneficiary's own signature: there is
/// no path for an organization or admin to use a customer's voucher.
entry fun use_voucher(
    account: &mut CreditAccount,
    terms: &VoucherTerms,
    reference: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tx_context::sender(ctx) == account.beneficiary, ENotBeneficiary);
    assert!(table::contains(&account.vouchers, reference), EUnknownVoucher);
    assert!(voucher_terms::is_unexpired(terms, clock::timestamp_ms(clock)), EVoucherNotActive);

    let terms_id = object::id(terms);
    let record = table::borrow_mut(&mut account.vouchers, reference);
    assert!(record.terms_id == terms_id, EWrongVoucherTerms);
    assert!(record.status == VOUCHER_AVAILABLE, EVoucherNotAvailable);
    record.status = VOUCHER_USED;

    event::emit(VoucherUsed {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        terms_id,
        reference,
    });
}

/// Cancels a paid, unused voucher and refunds its points in one transaction,
/// as non-expiring credits like `reverse_redeem`. An issuer can only take back
/// a voucher by returning what it cost: a granted voucher cannot be cancelled.
entry fun cancel_voucher(issuer: &IssuerCap, account: &mut CreditAccount, reference: vector<u8>, _ctx: &TxContext) {
    assert!(capabilities::issuer_program_id(issuer) == account.program_id, EWrongProgram);
    assert!(table::contains(&account.vouchers, reference), EUnknownVoucher);

    let record = table::borrow_mut(&mut account.vouchers, reference);
    assert!(record.status == VOUCHER_AVAILABLE, EVoucherNotAvailable);
    assert!(record.points_paid > 0, EVoucherNotPaid);
    record.status = VOUCHER_CANCELLED;
    let terms_id = record.terms_id;
    let points_refunded = record.points_paid;

    refund_redemption(account, copy reference);
    event::emit(VoucherCancelled {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        terms_id,
        points_refunded,
        reference,
    });
}

/// Undoes the earn recorded under `operation_key`: removes the bucket it
/// created and refunds its amount to the budget shard it was debited from.
/// Issuer-only, for the issuer's own program. `operation_shard` and
/// `budget_shard` must own `operation_key`, as for `earn`.
///
/// Aborts `EBucketUnavailable` if that bucket no longer holds the full
/// earned amount (partly redeemed) or has expired: a reversal never claws
/// back less than the earn, nor takes credits from another bucket. A second
/// reversal of the same key aborts `operation_shard::EAlreadyReversed`.
entry fun reverse_earn(
    issuer: &IssuerCap,
    account: &mut CreditAccount,
    operation_shard: &mut OperationShard,
    budget_shard: &mut BudgetShard,
    operation_key: vector<u8>,
    clock: &Clock,
    _ctx: &TxContext,
) {
    assert!(capabilities::issuer_program_id(issuer) == account.program_id, EWrongProgram);

    let (account_id, amount, seq) = operation_shard::mark_reversed(
        operation_shard,
        account.program_id,
        copy operation_key,
    );
    assert!(account_id == object::id(account), EWrongAccount);

    let (found, idx) = find_bucket_by_seq(&account.buckets, seq);
    assert!(found, EBucketUnavailable);
    let bucket = *vector::borrow(&account.buckets, idx);
    assert!(bucket.amount == amount && bucket.expires_at_ms > clock::timestamp_ms(clock), EBucketUnavailable);
    vector::remove(&mut account.buckets, idx);

    budget_shard::refund(budget_shard, account.program_id, &operation_key, amount);

    event::emit(CreditEarnReversed {
        account_id,
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        amount,
        operation_key,
    });
}

/// Gives back what the `redeem` named `reference` spent, as non-expiring
/// credits (matching the off-chain ledger, where a reversed redemption's
/// add-back has no expiry bucket). Issuer-only, for the issuer's own
/// program; at most once per `reference`.
entry fun reverse_redeem(issuer: &IssuerCap, account: &mut CreditAccount, reference: vector<u8>, _ctx: &TxContext) {
    assert!(capabilities::issuer_program_id(issuer) == account.program_id, EWrongProgram);
    // An unused voucher goes through `cancel_voucher`, or the customer would keep it and the points.
    if (table::contains(&account.vouchers, reference)) {
        assert!(table::borrow(&account.vouchers, reference).status != VOUCHER_AVAILABLE, EVoucherStillAvailable);
    };
    refund_redemption(account, reference);
}

/// Shared by `redeem` and `claim_voucher`; each checks the signer first.
fun debit(account: &mut CreditAccount, cost: u64, reference: vector<u8>, clock: &Clock) {
    assert!(cost > 0, EZeroAmount);
    assert!(!table::contains(&account.redemptions, reference), EDuplicateRedemption);

    prune_expired(account, clock::timestamp_ms(clock));

    let mut remaining = cost;
    while (remaining > 0) {
        let len = vector::length(&account.buckets);
        if (len == 0) {
            assert!(account.non_expiring >= remaining, EInsufficientBalance);
            account.non_expiring = account.non_expiring - remaining;
            break
        };

        let idx = find_min_expiry_idx(&account.buckets);
        let bucket = vector::borrow_mut(&mut account.buckets, idx);
        if (bucket.amount <= remaining) {
            remaining = remaining - bucket.amount;
            vector::remove(&mut account.buckets, idx);
        } else {
            bucket.amount = bucket.amount - remaining;
            remaining = 0;
        };
    };

    account.lifetime_redeemed = account.lifetime_redeemed + cost;
    table::add(&mut account.redemptions, copy reference, Redemption { amount: cost, reversed: false });
    event::emit(CreditRedeemed {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        amount: cost,
        reference,
    });
}

/// Shared by `reverse_redeem` and `cancel_voucher`; each checks the issuer first.
fun refund_redemption(account: &mut CreditAccount, reference: vector<u8>) {
    assert!(table::contains(&account.redemptions, reference), EUnknownRedemption);

    let redemption = table::borrow_mut(&mut account.redemptions, reference);
    assert!(!redemption.reversed, ERedemptionAlreadyReversed);
    redemption.reversed = true;
    let amount = redemption.amount;
    account.non_expiring = account.non_expiring + amount;

    event::emit(CreditRedeemReversed {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        amount,
        reference,
    });
}

fun assert_terms_issuable(account: &CreditAccount, terms: &VoucherTerms, clock: &Clock) {
    assert!(voucher_terms::program_id(terms) == account.program_id, EWrongProgram);
    assert!(voucher_terms::is_issuable(terms, clock::timestamp_ms(clock)), EVoucherNotActive);
}

/// Read-only spendable total as of `clock`, for API/indexer reconciliation
/// against the PostgreSQL projection without needing a transaction.
public fun spendable(account: &CreditAccount, clock: &Clock): u64 {
    total_live(&account.buckets, clock::timestamp_ms(clock)) + account.non_expiring
}

/// `true` once `use_voucher` has marked this voucher used. Aborts for an unknown voucher.
public fun voucher_is_used(account: &CreditAccount, reference: vector<u8>): bool {
    assert!(table::contains(&account.vouchers, reference), EUnknownVoucher);
    table::borrow(&account.vouchers, reference).status == VOUCHER_USED
}

/// `true` once `cancel_voucher` has cancelled this voucher. Aborts for an unknown voucher.
public fun voucher_is_cancelled(account: &CreditAccount, reference: vector<u8>): bool {
    assert!(table::contains(&account.vouchers, reference), EUnknownVoucher);
    table::borrow(&account.vouchers, reference).status == VOUCHER_CANCELLED
}

public fun beneficiary(account: &CreditAccount): address {
    account.beneficiary
}

public fun program_id(account: &CreditAccount): ID {
    account.program_id
}

fun total_live(buckets: &vector<Bucket>, now_ms: u64): u64 {
    let mut total = 0u64;
    let mut i = 0;
    let n = vector::length(buckets);
    while (i < n) {
        let bucket = vector::borrow(buckets, i);
        if (bucket.expires_at_ms > now_ms) {
            total = total + bucket.amount;
        };
        i = i + 1;
    };
    total
}

/// Drops already-expired buckets and emits their forfeited total, so
/// expiry is observable off-chain even though no one paid gas just to
/// let credits lapse.
fun prune_expired(account: &mut CreditAccount, now_ms: u64) {
    let mut forfeited = 0u64;
    let mut i = 0;
    while (i < vector::length(&account.buckets)) {
        let bucket = *vector::borrow(&account.buckets, i);
        if (bucket.expires_at_ms <= now_ms) {
            forfeited = forfeited + bucket.amount;
            vector::remove(&mut account.buckets, i);
        } else {
            i = i + 1;
        };
    };

    if (forfeited > 0) {
        event::emit(CreditExpired {
            account_id: object::id(account),
            program_id: account.program_id,
            amount: forfeited,
        });
    };
}

fun find_bucket_by_seq(buckets: &vector<Bucket>, seq: u64): (bool, u64) {
    let mut i = 0;
    let n = vector::length(buckets);
    while (i < n) {
        if (vector::borrow(buckets, i).seq == seq) {
            return (true, i)
        };
        i = i + 1;
    };
    (false, 0)
}

/// Caller must ensure `buckets` is non-empty.
fun find_min_expiry_idx(buckets: &vector<Bucket>): u64 {
    let n = vector::length(buckets);
    let mut best_idx = 0;
    let mut best_expiry = vector::borrow(buckets, 0).expires_at_ms;
    let mut i = 1;
    while (i < n) {
        let expiry = vector::borrow(buckets, i).expires_at_ms;
        if (expiry < best_expiry) {
            best_idx = i;
            best_expiry = expiry;
        };
        i = i + 1;
    };
    best_idx
}
