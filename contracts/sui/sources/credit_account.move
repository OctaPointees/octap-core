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
module octap::credit_account;

use octap::budget_shard::{Self, BudgetShard};
use octap::capabilities::{Self, IssuerCap};
use octap::operation_shard::{Self, OperationShard};
use octap::program_control::{Self, ProgramControl};
use octap::policy_version::{Self, PolicyVersion};
use sui::clock::{Self, Clock};
use sui::event;

const EWrongProgram: u64 = 0;
const ENotBeneficiary: u64 = 1;
const EZeroAmount: u64 = 2;
const EInsufficientBalance: u64 = 3;
const EZeroEarn: u64 = 4;

public struct Bucket has store, drop, copy {
    expires_at_ms: u64,
    amount: u64,
}

public struct CreditAccount has key {
    id: UID,
    program_id: ID,
    beneficiary: address,
    buckets: vector<Bucket>,
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

    operation_shard::check_and_record(operation_shard, account.program_id, copy operation_key);
    budget_shard::debit(budget_shard, account.program_id, &operation_key, amount);

    let expires_at_ms = clock::timestamp_ms(clock) + policy_version::expiry_ms(policy);
    vector::push_back(&mut account.buckets, Bucket { expires_at_ms, amount });
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

/// Debits `cost` credits, consuming the nearest-to-expiry bucket(s) first.
/// Requires the beneficiary's own signature (`sender == beneficiary`):
/// there is no path for an organization or admin to spend on a member's
/// behalf, matching the non-transferable, consent-gated redemption rule.
entry fun redeem(account: &mut CreditAccount, cost: u64, reference: vector<u8>, clock: &Clock, ctx: &TxContext) {
    assert!(tx_context::sender(ctx) == account.beneficiary, ENotBeneficiary);
    assert!(cost > 0, EZeroAmount);

    prune_expired(account, clock::timestamp_ms(clock));

    let mut remaining = cost;
    while (remaining > 0) {
        let len = vector::length(&account.buckets);
        assert!(len > 0, EInsufficientBalance);

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
    event::emit(CreditRedeemed {
        account_id: object::id(account),
        program_id: account.program_id,
        beneficiary: account.beneficiary,
        amount: cost,
        reference,
    });
}

/// Read-only spendable total as of `clock`, for API/indexer reconciliation
/// against the PostgreSQL projection without needing a transaction.
public fun spendable(account: &CreditAccount, clock: &Clock): u64 {
    total_live(&account.buckets, clock::timestamp_ms(clock))
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
