#[test_only]
module octap::reversal_tests;

use sui::test_scenario as ts;
use sui::clock::{Self, Clock};
use octap::capabilities::{AdminCap, IssuerCap};
use octap::program_control::{Self, ProgramControl};
use octap::policy_version::{Self, PolicyVersion};
use octap::credit_account::{Self, CreditAccount};
use octap::operation_shard::{Self, OperationShard};
use octap::budget_shard::{Self, BudgetShard};

const ADMIN: address = @0xA;
const ISSUER: address = @0xB;
const MEMBER: address = @0xC;
const OTHER: address = @0xD;
const ISSUER_B: address = @0xE;
const DAY_MS: u64 = 86_400_000;
const BUDGET: u64 = 1_000_000;
/// At the setup policy's 100 bps, every earn below credits exactly 100.
const PURCHASE: u64 = 10_000;

public struct Ids has drop {
    op_shard: ID,
    budget: ID,
    account: ID,
}

/// A program with an active 100-bps / 1-day policy, one shard pair holding
/// `BUDGET`, an IssuerCap for `ISSUER`, and one account for `MEMBER`.
fun setup(scenario: &mut ts::Scenario): Ids {
    let admin_cap = program_control::create_program(ts::ctx(scenario));
    transfer::public_transfer(admin_cap, ADMIN);

    ts::next_tx(scenario, ADMIN);
    let program = ts::take_shared<ProgramControl>(scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    policy_version::publish(&admin_cap, object::id(&program), 1, 100, DAY_MS, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ADMIN);
    let mut program = ts::take_shared<ProgramControl>(scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    program_control::activate_policy(&admin_cap, &mut program, &policy, ts::ctx(scenario));
    program_control::issue_cap(&admin_cap, &program, ISSUER, ts::ctx(scenario));
    let program_id = object::id(&program);
    let op_ids = operation_shard::create_shards(&admin_cap, program_id, 1, ts::ctx(scenario));
    let budget_ids = budget_shard::create_shards(&admin_cap, program_id, BUDGET, 1, ts::ctx(scenario));
    ts::return_immutable(policy);
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    let account = open_account_for(scenario, MEMBER);
    Ids { op_shard: op_ids[0], budget: budget_ids[0], account }
}

fun open_account_for(scenario: &mut ts::Scenario, beneficiary: address): ID {
    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    credit_account::open_account(&issuer_cap, &program, beneficiary, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, issuer_cap);
    ts::next_tx(scenario, ISSUER);
    ts::most_recent_id_shared<CreditAccount>().destroy_some()
}

fun earn(scenario: &mut ts::Scenario, ids: &Ids, account_id: ID, key: vector<u8>, clock: &Clock) {
    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, account_id);
    let mut op_shard = ts::take_shared_by_id<OperationShard>(scenario, ids.op_shard);
    let mut budget = ts::take_shared_by_id<BudgetShard>(scenario, ids.budget);
    credit_account::earn(
        &issuer_cap,
        &program,
        &policy,
        &mut account,
        &mut op_shard,
        &mut budget,
        PURCHASE,
        key,
        clock,
        ts::ctx(scenario),
    );
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);
}

fun redeem(scenario: &mut ts::Scenario, ids: &Ids, cost: u64, reference: vector<u8>, clock: &Clock) {
    ts::next_tx(scenario, MEMBER);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, ids.account);
    credit_account::redeem(&mut account, cost, reference, clock, ts::ctx(scenario));
    ts::return_shared(account);
}

/// `reverse_earn` as `issuer` (who must hold an IssuerCap) against `account_id`.
fun reverse_earn_as(
    scenario: &mut ts::Scenario,
    issuer: address,
    ids: &Ids,
    account_id: ID,
    key: vector<u8>,
    clock: &Clock,
) {
    ts::next_tx(scenario, issuer);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, account_id);
    let mut op_shard = ts::take_shared_by_id<OperationShard>(scenario, ids.op_shard);
    let mut budget = ts::take_shared_by_id<BudgetShard>(scenario, ids.budget);
    credit_account::reverse_earn(&issuer_cap, &mut account, &mut op_shard, &mut budget, key, clock, ts::ctx(scenario));
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
}

fun reverse_earn(scenario: &mut ts::Scenario, ids: &Ids, key: vector<u8>, clock: &Clock) {
    reverse_earn_as(scenario, ISSUER, ids, ids.account, key, clock);
}

fun reverse_redeem_as(scenario: &mut ts::Scenario, issuer: address, ids: &Ids, reference: vector<u8>) {
    ts::next_tx(scenario, issuer);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared_by_id<CreditAccount>(scenario, ids.account);
    credit_account::reverse_redeem(&issuer_cap, &mut account, reference, ts::ctx(scenario));
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
}

fun spendable(scenario: &mut ts::Scenario, ids: &Ids, clock: &Clock): u64 {
    ts::next_tx(scenario, ISSUER);
    let account = ts::take_shared_by_id<CreditAccount>(scenario, ids.account);
    let total = credit_account::spendable(&account, clock);
    ts::return_shared(account);
    total
}

fun budget_remaining(scenario: &mut ts::Scenario, ids: &Ids): u64 {
    ts::next_tx(scenario, ISSUER);
    let budget = ts::take_shared_by_id<BudgetShard>(scenario, ids.budget);
    let remaining = budget_shard::remaining(&budget);
    ts::return_shared(budget);
    remaining
}

/// A second, independent program whose IssuerCap goes to `ISSUER_B`.
fun issue_cap_of_another_program(scenario: &mut ts::Scenario) {
    let admin_cap_b = program_control::create_program(ts::ctx(scenario));
    transfer::public_transfer(admin_cap_b, OTHER);
    ts::next_tx(scenario, OTHER);
    let program_b = ts::most_recent_id_shared<ProgramControl>().destroy_some();
    let program_b = ts::take_shared_by_id<ProgramControl>(scenario, program_b);
    let admin_cap_b = ts::take_from_sender<AdminCap>(scenario);
    program_control::issue_cap(&admin_cap_b, &program_b, ISSUER_B, ts::ctx(scenario));
    ts::return_to_sender(scenario, admin_cap_b);
    ts::return_shared(program_b);
}

// === reverse_earn ===

#[test]
fun reverse_earn_removes_only_that_earns_bucket_and_refunds_its_budget() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    // Same clock, so both buckets share one expiry: only the seq tells them apart.
    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    earn(&mut scenario, &ids, ids.account, b"op-2", &clock);
    assert!(budget_remaining(&mut scenario, &ids) == BUDGET - 200, 0);

    reverse_earn(&mut scenario, &ids, b"op-1", &clock);
    assert!(spendable(&mut scenario, &ids, &clock) == 100, 1);
    assert!(budget_remaining(&mut scenario, &ids) == BUDGET - 100, 2);

    ts::next_tx(&mut scenario, ISSUER);
    let op_shard = ts::take_shared_by_id<OperationShard>(&scenario, ids.op_shard);
    assert!(operation_shard::is_reversed(&op_shard, b"op-1"), 3);
    assert!(!operation_shard::is_reversed(&op_shard, b"op-2"), 4);
    ts::return_shared(op_shard);

    // op-2's bucket is intact and fully spendable.
    redeem(&mut scenario, &ids, 100, b"r-1", &clock);
    assert!(spendable(&mut scenario, &ids, &clock) == 0, 5);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 6, location = octap::credit_account)] // EBucketUnavailable
fun reverse_earn_aborts_once_its_bucket_is_partly_spent() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 40, b"r-1", &clock);
    reverse_earn(&mut scenario, &ids, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 6, location = octap::credit_account)] // EBucketUnavailable
fun reverse_earn_aborts_once_its_bucket_is_fully_spent() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    earn(&mut scenario, &ids, ids.account, b"op-2", &clock);
    // FIFO among equal expiries takes op-1's bucket (the first) whole: it's gone from the vector.
    redeem(&mut scenario, &ids, 100, b"r-1", &clock);
    reverse_earn(&mut scenario, &ids, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 6, location = octap::credit_account)] // EBucketUnavailable
fun reverse_earn_aborts_once_its_bucket_has_expired() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    clock::increment_for_testing(&mut clock, DAY_MS);
    reverse_earn(&mut scenario, &ids, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 5, location = octap::operation_shard)] // EAlreadyReversed
fun reverse_earn_twice_aborts_on_chain() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    earn(&mut scenario, &ids, ids.account, b"op-2", &clock);
    reverse_earn(&mut scenario, &ids, b"op-1", &clock);
    reverse_earn(&mut scenario, &ids, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 4, location = octap::operation_shard)] // EUnknownOperation
fun reverse_earn_of_a_key_never_earned_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    reverse_earn(&mut scenario, &ids, b"op-404", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 0, location = octap::credit_account)] // EWrongProgram
fun reverse_earn_rejects_issuer_cap_of_another_program() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    issue_cap_of_another_program(&mut scenario);
    reverse_earn_as(&mut scenario, ISSUER_B, &ids, ids.account, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 5, location = octap::credit_account)] // EWrongAccount
fun reverse_earn_rejects_another_members_account() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let other_account = open_account_for(&mut scenario, OTHER);

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    earn(&mut scenario, &ids, other_account, b"op-2", &clock);
    // op-1 was earned into MEMBER's account; it can't be clawed back from OTHER's.
    reverse_earn_as(&mut scenario, ISSUER, &ids, other_account, b"op-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

// === reverse_redeem ===

#[test]
fun reverse_redeem_gives_credits_back_without_expiry() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 40, b"r-1", &clock);
    reverse_redeem_as(&mut scenario, ISSUER, &ids, b"r-1");
    assert!(spendable(&mut scenario, &ids, &clock) == 100, 0);

    // Past the bucket's expiry, only the given-back 40 is left, and it's still spendable.
    clock::increment_for_testing(&mut clock, DAY_MS);
    assert!(spendable(&mut scenario, &ids, &clock) == 40, 1);
    redeem(&mut scenario, &ids, 40, b"r-2", &clock);
    assert!(spendable(&mut scenario, &ids, &clock) == 0, 2);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun redeem_spends_live_buckets_before_given_back_credits() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 30, b"r-1", &clock);
    reverse_redeem_as(&mut scenario, ISSUER, &ids, b"r-1");
    // 70 left in the bucket + 30 non-expiring; spending 70 must empty the bucket, not the 30.
    redeem(&mut scenario, &ids, 70, b"r-2", &clock);
    assert!(spendable(&mut scenario, &ids, &clock) == 30, 0);
    clock::increment_for_testing(&mut clock, DAY_MS);
    assert!(spendable(&mut scenario, &ids, &clock) == 30, 1);
    // Overspending past both aborts as before; spending exactly the rest drains it.
    redeem(&mut scenario, &ids, 30, b"r-3", &clock);
    assert!(spendable(&mut scenario, &ids, &clock) == 0, 2);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 8, location = octap::credit_account)] // ERedemptionAlreadyReversed
fun reverse_redeem_twice_aborts_on_chain() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 40, b"r-1", &clock);
    reverse_redeem_as(&mut scenario, ISSUER, &ids, b"r-1");
    reverse_redeem_as(&mut scenario, ISSUER, &ids, b"r-1");

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 7, location = octap::credit_account)] // EUnknownRedemption
fun reverse_redeem_of_an_unknown_reference_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    reverse_redeem_as(&mut scenario, ISSUER, &ids, b"r-404");

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 0, location = octap::credit_account)] // EWrongProgram
fun reverse_redeem_rejects_issuer_cap_of_another_program() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 40, b"r-1", &clock);
    issue_cap_of_another_program(&mut scenario);
    reverse_redeem_as(&mut scenario, ISSUER_B, &ids, b"r-1");

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 9, location = octap::credit_account)] // EDuplicateRedemption
fun redeem_rejects_a_reused_reference() {
    let mut scenario = ts::begin(ADMIN);
    let ids = setup(&mut scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    earn(&mut scenario, &ids, ids.account, b"op-1", &clock);
    redeem(&mut scenario, &ids, 10, b"r-1", &clock);
    redeem(&mut scenario, &ids, 10, b"r-1", &clock);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}
