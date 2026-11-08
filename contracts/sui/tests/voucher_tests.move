#[test_only]
module octap::voucher_tests;

use sui::test_scenario as ts;
use sui::clock::{Self, Clock};
use octap::capabilities::{AdminCap, IssuerCap};
use octap::program_control::{Self, ProgramControl};
use octap::policy_version::{Self, PolicyVersion};
use octap::credit_account::{Self, CreditAccount};
use octap::operation_shard::{Self, OperationShard};
use octap::budget_shard::{Self, BudgetShard};
use octap::voucher_terms::{Self, VoucherTerms};

const ADMIN: address = @0xA;
const ISSUER: address = @0xB;
const MEMBER: address = @0xC;
const OTHER: address = @0xD;
const ISSUER_B: address = @0xE;
const DAY_MS: u64 = 86_400_000;
/// At the setup policy's 100 bps, one earn credits exactly 100.
const PURCHASE: u64 = 10_000;
const COST: u64 = 40;

public struct Setup has drop {
    program: ID,
    account: ID,
}

/// A program with an active 100-bps policy, an IssuerCap for `ISSUER`, and an
/// account for `MEMBER` holding 100 credits that last ten days.
fun setup(scenario: &mut ts::Scenario, clock: &Clock): Setup {
    let admin_cap = program_control::create_program(ts::ctx(scenario));
    transfer::public_transfer(admin_cap, ADMIN);

    ts::next_tx(scenario, ADMIN);
    let program = ts::take_shared<ProgramControl>(scenario);
    let program_id = object::id(&program);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    policy_version::publish(&admin_cap, program_id, 1, 100, 10 * DAY_MS, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ADMIN);
    let mut program = ts::take_shared<ProgramControl>(scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    program_control::activate_policy(&admin_cap, &mut program, &policy, ts::ctx(scenario));
    program_control::issue_cap(&admin_cap, &program, ISSUER, ts::ctx(scenario));
    let op_ids = operation_shard::create_shards(&admin_cap, program_id, 1, ts::ctx(scenario));
    let budget_ids = budget_shard::create_shards(&admin_cap, program_id, 1_000_000, 1, ts::ctx(scenario));
    ts::return_immutable(policy);
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    credit_account::open_account(&issuer_cap, &program, MEMBER, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, issuer_cap);

    ts::next_tx(scenario, ISSUER);
    let account_id = ts::most_recent_id_shared<CreditAccount>().destroy_some();
    let program = ts::take_shared<ProgramControl>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, account_id);
    let mut op_shard = ts::take_shared_by_id<OperationShard>(scenario, op_ids[0]);
    let mut budget = ts::take_shared_by_id<BudgetShard>(scenario, budget_ids[0]);
    credit_account::earn(
        &issuer_cap,
        &program,
        &policy,
        &mut account,
        &mut op_shard,
        &mut budget,
        PURCHASE,
        b"earn",
        clock,
        ts::ctx(scenario),
    );
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    Setup { program: program_id, account: account_id }
}

/// Publishes terms as `ISSUER` and returns their id.
fun publish(scenario: &mut ts::Scenario, setup: &Setup, cost: u64, starts: u64, expires: u64): ID {
    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared_by_id<ProgramControl>(scenario, setup.program);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    voucher_terms::publish_terms(
        &issuer_cap,
        &program,
        b"voucher",
        b"{\"title\":\"10% off\"}",
        cost,
        starts,
        expires,
        ts::ctx(scenario),
    );
    ts::return_shared(program);
    ts::return_to_sender(scenario, issuer_cap);
    let effects = ts::next_tx(scenario, ISSUER);
    ts::frozen(&effects)[0]
}

fun claim_as(scenario: &mut ts::Scenario, sender: address, setup: &Setup, terms: ID, reference: vector<u8>, clock: &Clock) {
    ts::next_tx(scenario, sender);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let voucher = ts::take_immutable_by_id<VoucherTerms>(scenario, terms);
    credit_account::claim_voucher(&mut account, &voucher, reference, clock, ts::ctx(scenario));
    ts::return_immutable(voucher);
    ts::return_shared(account);
}

fun grant(scenario: &mut ts::Scenario, setup: &Setup, terms: ID, reference: vector<u8>, clock: &Clock) {
    ts::next_tx(scenario, ISSUER);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let voucher = ts::take_immutable_by_id<VoucherTerms>(scenario, terms);
    credit_account::grant_voucher(&issuer_cap, &mut account, &voucher, reference, clock, ts::ctx(scenario));
    ts::return_immutable(voucher);
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
}

fun use_as(scenario: &mut ts::Scenario, sender: address, setup: &Setup, terms: ID, reference: vector<u8>, clock: &Clock) {
    ts::next_tx(scenario, sender);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let voucher = ts::take_immutable_by_id<VoucherTerms>(scenario, terms);
    credit_account::use_voucher(&mut account, &voucher, reference, clock, ts::ctx(scenario));
    ts::return_immutable(voucher);
    ts::return_shared(account);
}

fun cancel(scenario: &mut ts::Scenario, setup: &Setup, reference: vector<u8>) {
    ts::next_tx(scenario, ISSUER);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    credit_account::cancel_voucher(&issuer_cap, &mut account, reference, ts::ctx(scenario));
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
}

fun reverse_redeem(scenario: &mut ts::Scenario, setup: &Setup, reference: vector<u8>) {
    ts::next_tx(scenario, ISSUER);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    credit_account::reverse_redeem(&issuer_cap, &mut account, reference, ts::ctx(scenario));
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
}

fun spendable_of(scenario: &mut ts::Scenario, setup: &Setup, clock: &Clock): u64 {
    ts::next_tx(scenario, MEMBER);
    let account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let spendable = credit_account::spendable(&account, clock);
    ts::return_shared(account);
    spendable
}

fun is_used(scenario: &mut ts::Scenario, setup: &Setup, reference: vector<u8>): bool {
    ts::next_tx(scenario, MEMBER);
    let account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let used = credit_account::voucher_is_used(&account, reference);
    ts::return_shared(account);
    used
}

fun is_cancelled(scenario: &mut ts::Scenario, setup: &Setup, reference: vector<u8>): bool {
    ts::next_tx(scenario, MEMBER);
    let account = ts::take_shared_by_id<CreditAccount>(scenario, setup.account);
    let cancelled = credit_account::voucher_is_cancelled(&account, reference);
    ts::return_shared(account);
    cancelled
}

fun start(): (ts::Scenario, Clock) {
    let mut scenario = ts::begin(ADMIN);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    (scenario, clock)
}

fun finish(scenario: ts::Scenario, clock: Clock) {
    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun published_terms_are_frozen_and_readable() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);

    ts::next_tx(&mut scenario, OTHER);
    let voucher = ts::take_immutable_by_id<VoucherTerms>(&scenario, terms);
    assert!(voucher_terms::points_cost(&voucher) == COST);
    assert!(voucher_terms::program_id(&voucher) == s.program);
    assert!(voucher_terms::terms(&voucher) == b"{\"title\":\"10% off\"}");
    ts::return_immutable(voucher);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 0, location = octap::voucher_terms)] // EWrongProgram
fun publish_rejects_issuer_cap_of_another_program() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);

    // Program B's cap, against program A.
    ts::next_tx(&mut scenario, ISSUER_B);
    let admin_cap_b = program_control::create_program(ts::ctx(&mut scenario));
    let program_b_id = capabilities_program(&admin_cap_b);
    ts::next_tx(&mut scenario, ISSUER_B);
    let program_b = ts::take_shared_by_id<ProgramControl>(&scenario, program_b_id);
    program_control::issue_cap(&admin_cap_b, &program_b, ISSUER_B, ts::ctx(&mut scenario));
    ts::return_shared(program_b);
    transfer::public_transfer(admin_cap_b, ISSUER_B);

    ts::next_tx(&mut scenario, ISSUER_B);
    let issuer_b = ts::take_from_sender<IssuerCap>(&scenario);
    let program_a = ts::take_shared_by_id<ProgramControl>(&scenario, s.program);
    voucher_terms::publish_terms(&issuer_b, &program_a, b"v", b"{}", COST, 0, 0, ts::ctx(&mut scenario));
    ts::return_shared(program_a);
    ts::return_to_sender(&scenario, issuer_b);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 1, location = octap::voucher_terms)] // EEmptyTerms
fun publish_rejects_empty_terms() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    ts::next_tx(&mut scenario, ISSUER);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let program = ts::take_shared_by_id<ProgramControl>(&scenario, s.program);
    voucher_terms::publish_terms(&issuer_cap, &program, b"v", b"", COST, 0, 0, ts::ctx(&mut scenario));
    ts::return_shared(program);
    ts::return_to_sender(&scenario, issuer_cap);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 2, location = octap::voucher_terms)] // EInvalidWindow
fun publish_rejects_a_window_that_ends_before_it_starts() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    publish(&mut scenario, &s, COST, DAY_MS, DAY_MS);
    finish(scenario, clock);
}

#[test]
fun claim_debits_the_terms_price_and_records_the_voucher() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);

    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);

    assert!(spendable_of(&mut scenario, &s, &clock) == 100 - COST);
    assert!(!is_used(&mut scenario, &s, b"v1"));
    assert!(!is_cancelled(&mut scenario, &s, b"v1"));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 1, location = octap::credit_account)] // ENotBeneficiary
fun claim_rejects_anyone_but_the_beneficiary() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, ISSUER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 10, location = octap::credit_account)] // EDuplicateVoucher
fun claim_rejects_a_reused_reference() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 2, location = octap::credit_account)] // EZeroAmount
fun claim_rejects_free_terms_because_a_free_voucher_is_granted() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 3, location = octap::credit_account)] // EInsufficientBalance
fun claim_leaves_no_voucher_without_enough_points() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 101, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 13, location = octap::credit_account)] // EVoucherNotActive
fun claim_rejects_terms_that_have_not_started() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, DAY_MS, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test]
fun claim_accepts_terms_usable_for_a_full_day() {
    let (mut scenario, mut clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 2 * DAY_MS);
    clock::set_for_testing(&mut clock, DAY_MS);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    assert!(spendable_of(&mut scenario, &s, &clock) == 100 - COST);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 13, location = octap::credit_account)] // EVoucherNotActive
fun claim_rejects_terms_that_expire_within_a_day() {
    let (mut scenario, mut clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 2 * DAY_MS);
    clock::set_for_testing(&mut clock, DAY_MS + 1);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test]
fun grant_records_a_voucher_without_spending_points_or_a_customer_signature() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);

    grant(&mut scenario, &s, terms, b"gift", &clock);

    assert!(spendable_of(&mut scenario, &s, &clock) == 100);
    assert!(!is_used(&mut scenario, &s, b"gift"));
    finish(scenario, clock);
}

#[test]
fun the_beneficiary_uses_a_voucher_once() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    grant(&mut scenario, &s, terms, b"gift", &clock);

    use_as(&mut scenario, MEMBER, &s, terms, b"gift", &clock);

    assert!(is_used(&mut scenario, &s, b"gift"));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 1, location = octap::credit_account)] // ENotBeneficiary
fun an_issuer_cannot_use_a_customers_voucher() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    grant(&mut scenario, &s, terms, b"gift", &clock);
    use_as(&mut scenario, ISSUER, &s, terms, b"gift", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 12, location = octap::credit_account)] // EVoucherNotAvailable
fun a_voucher_cannot_be_used_twice() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    grant(&mut scenario, &s, terms, b"gift", &clock);
    use_as(&mut scenario, MEMBER, &s, terms, b"gift", &clock);
    use_as(&mut scenario, MEMBER, &s, terms, b"gift", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 13, location = octap::credit_account)] // EVoucherNotActive
fun an_expired_voucher_cannot_be_used() {
    let (mut scenario, mut clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, DAY_MS);
    grant(&mut scenario, &s, terms, b"gift", &clock);
    clock::set_for_testing(&mut clock, DAY_MS);
    use_as(&mut scenario, MEMBER, &s, terms, b"gift", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 11, location = octap::credit_account)] // EUnknownVoucher
fun an_unknown_voucher_cannot_be_used() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    use_as(&mut scenario, MEMBER, &s, terms, b"gift", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 14, location = octap::credit_account)] // EWrongVoucherTerms
fun use_rejects_terms_the_voucher_was_not_issued_under() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, 0, 0, 0);
    let other_terms = publish(&mut scenario, &s, 0, 0, 0);
    grant(&mut scenario, &s, terms, b"gift", &clock);
    use_as(&mut scenario, MEMBER, &s, other_terms, b"gift", &clock);
    finish(scenario, clock);
}

#[test]
fun cancel_refunds_a_paid_voucher_and_it_stays_unusable() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);

    cancel(&mut scenario, &s, b"v1");

    assert!(spendable_of(&mut scenario, &s, &clock) == 100);
    assert!(is_cancelled(&mut scenario, &s, b"v1"));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 12, location = octap::credit_account)] // EVoucherNotAvailable
fun a_cancelled_voucher_cannot_be_used() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    cancel(&mut scenario, &s, b"v1");
    use_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 12, location = octap::credit_account)] // EVoucherNotAvailable
fun a_used_voucher_cannot_be_cancelled() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    use_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    cancel(&mut scenario, &s, b"v1");
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 15, location = octap::credit_account)] // EVoucherNotPaid
fun a_granted_voucher_cannot_be_taken_back() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    grant(&mut scenario, &s, terms, b"gift", &clock);
    cancel(&mut scenario, &s, b"gift");
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 16, location = octap::credit_account)] // EVoucherStillAvailable
fun reverse_redeem_cannot_refund_an_unused_voucher() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    reverse_redeem(&mut scenario, &s, b"v1");
    finish(scenario, clock);
}

#[test]
fun reverse_redeem_refunds_a_used_voucher_and_keeps_it_used() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    use_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);

    reverse_redeem(&mut scenario, &s, b"v1");

    assert!(spendable_of(&mut scenario, &s, &clock) == 100);
    assert!(is_used(&mut scenario, &s, b"v1"));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = 8, location = octap::credit_account)] // ERedemptionAlreadyReversed
fun a_cancelled_voucher_is_not_refunded_twice() {
    let (mut scenario, clock) = start();
    let s = setup(&mut scenario, &clock);
    let terms = publish(&mut scenario, &s, COST, 0, 0);
    claim_as(&mut scenario, MEMBER, &s, terms, b"v1", &clock);
    cancel(&mut scenario, &s, b"v1");
    reverse_redeem(&mut scenario, &s, b"v1");
    finish(scenario, clock);
}

fun capabilities_program(admin_cap: &AdminCap): ID {
    octap::capabilities::admin_program_id(admin_cap)
}
