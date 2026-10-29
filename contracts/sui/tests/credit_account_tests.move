#[test_only]
module octap::credit_account_tests;

use sui::test_scenario as ts;
use sui::clock;
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
const DEFAULT_BUDGET: u64 = 1_000_000;

/// Builds a program with an activated 100-bps / 1-day-expiry policy, one
/// operation shard and one budget shard holding `DEFAULT_BUDGET`, and an
/// IssuerCap sent to `ISSUER`, leaving the scenario positioned right after
/// that setup so each test only has to open an account and act.
fun setup(scenario: &mut ts::Scenario) {
    setup_with_shards(scenario, DEFAULT_BUDGET, 1);
}

/// `setup` with an explicit budget and shard count. Returns the operation
/// and budget shard ids in shard-index order.
fun setup_with_shards(scenario: &mut ts::Scenario, total_budget: u64, shard_count: u64): (vector<ID>, vector<ID>) {
    let admin_cap = program_control::create_program(ts::ctx(scenario));
    transfer::public_transfer(admin_cap, ADMIN);

    ts::next_tx(scenario, ADMIN);
    let program = ts::take_shared<ProgramControl>(scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    let program_id = object::id(&program);
    policy_version::publish(&admin_cap, program_id, 1, 100, DAY_MS, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ADMIN);
    let mut program = ts::take_shared<ProgramControl>(scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    program_control::activate_policy(&admin_cap, &mut program, &policy, ts::ctx(scenario));
    program_control::issue_cap(&admin_cap, &program, ISSUER, ts::ctx(scenario));
    let program_id = object::id(&program);
    let operation_shard_ids = operation_shard::create_shards(&admin_cap, program_id, shard_count, ts::ctx(scenario));
    let budget_shard_ids = budget_shard::create_shards(&admin_cap, program_id, total_budget, shard_count, ts::ctx(scenario));
    ts::return_immutable(policy);
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    credit_account::open_account(&issuer_cap, &program, MEMBER, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, issuer_cap);

    (operation_shard_ids, budget_shard_ids)
}

#[test]
fun earn_then_redeem_happy_path() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(&scenario);
    let policy = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    // 10_000-unit purchase at 100 bps (1%) earns 100 credits.
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, &mut op_shard, &mut budget, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    assert!(credit_account::spendable(&account, &clock) == 100, 0);

    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    ts::next_tx(&mut scenario, MEMBER);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    credit_account::redeem(&mut account, 40, b"voucher-1", &clock, ts::ctx(&mut scenario));
    assert!(credit_account::spendable(&account, &clock) == 60, 1);
    ts::return_shared(account);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 1)] // credit_account::ENotBeneficiary
fun redeem_rejects_non_beneficiary() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(&scenario);
    let policy = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, &mut op_shard, &mut budget, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    // OTHER is not the account's beneficiary (MEMBER is) — must abort.
    ts::next_tx(&mut scenario, OTHER);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    credit_account::redeem(&mut account, 10, b"voucher-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(account);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 3)] // credit_account::EInsufficientBalance
fun redeem_rejects_overspend() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(&scenario);
    let policy = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, &mut op_shard, &mut budget, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    ts::next_tx(&mut scenario, MEMBER);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    credit_account::redeem(&mut account, 101, b"voucher-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(account);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun expired_buckets_are_not_spendable() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(&scenario);
    let policy = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(&issuer_cap, &program, &policy, &mut account, &mut op_shard, &mut budget, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    assert!(credit_account::spendable(&account, &clock) == 100, 0);

    // Past the 1-day expiry window: the bucket must no longer count.
    clock::increment_for_testing(&mut clock, DAY_MS + 1);
    assert!(credit_account::spendable(&account, &clock) == 0, 1);

    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

/// Re-provisions the organization from `setup`: a second program with its own
/// policy, IssuerCap (sent to `ISSUER_B`) and shards. `MEMBER`'s account from
/// `setup` stays in the first program. Returns the new program, policy,
/// operation shard and budget shard ids.
fun reprovision(scenario: &mut ts::Scenario): (ID, ID, ID, ID) {
    ts::next_tx(scenario, ADMIN);
    let admin_cap_b = program_control::create_program(ts::ctx(scenario));
    let admin_cap_b_id = object::id(&admin_cap_b);
    transfer::public_transfer(admin_cap_b, ADMIN);

    ts::next_tx(scenario, ADMIN);
    let program_b_id = ts::most_recent_id_shared<ProgramControl>().destroy_some();
    let admin_cap_b = ts::take_from_sender_by_id<AdminCap>(scenario, admin_cap_b_id);
    policy_version::publish(&admin_cap_b, program_b_id, 1, 100, DAY_MS, ts::ctx(scenario));
    ts::return_to_sender(scenario, admin_cap_b);

    ts::next_tx(scenario, ADMIN);
    let policy_b_id = ts::most_recent_immutable_id<PolicyVersion>().destroy_some();
    let mut program_b = ts::take_shared_by_id<ProgramControl>(scenario, program_b_id);
    let admin_cap_b = ts::take_from_sender_by_id<AdminCap>(scenario, admin_cap_b_id);
    let policy_b = ts::take_immutable_by_id<PolicyVersion>(scenario, policy_b_id);
    program_control::activate_policy(&admin_cap_b, &mut program_b, &policy_b, ts::ctx(scenario));
    program_control::issue_cap(&admin_cap_b, &program_b, ISSUER_B, ts::ctx(scenario));
    let operation_shard_ids = operation_shard::create_shards(&admin_cap_b, program_b_id, 1, ts::ctx(scenario));
    let budget_shard_ids = budget_shard::create_shards(&admin_cap_b, program_b_id, DEFAULT_BUDGET, 1, ts::ctx(scenario));
    ts::return_immutable(policy_b);
    ts::return_shared(program_b);
    ts::return_to_sender(scenario, admin_cap_b);

    (program_b_id, policy_b_id, operation_shard_ids[0], budget_shard_ids[0])
}

#[test, expected_failure(abort_code = 0)] // credit_account::EWrongProgram
fun earn_rejects_issuer_cap_scoped_to_a_different_program() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let program_a = ts::take_shared<ProgramControl>(&scenario);
    let program_a_id = object::id(&program_a);
    ts::return_shared(program_a);

    // A second, fully independent program, with its own IssuerCap minted to ISSUER_B. It
    // never touches program A's policy or account — only needs to exist so ISSUER_B holds a
    // capability scoped elsewhere.
    let admin_cap_b = program_control::create_program(ts::ctx(&mut scenario));
    transfer::public_transfer(admin_cap_b, ADMIN);

    ts::next_tx(&mut scenario, ADMIN);
    let program_b = ts::take_shared<ProgramControl>(&scenario);
    let admin_cap_b = ts::take_from_sender<AdminCap>(&scenario);
    program_control::issue_cap(&admin_cap_b, &program_b, ISSUER_B, ts::ctx(&mut scenario));
    ts::return_to_sender(&scenario, admin_cap_b);
    ts::return_shared(program_b);

    // ISSUER_B's cap is scoped to program B — using it against program A's account must abort
    // with `EWrongProgram`, tenant isolation enforced by the chain itself, not application code.
    ts::next_tx(&mut scenario, ISSUER_B);
    let program_a = ts::take_shared_by_id<ProgramControl>(&scenario, program_a_id);
    let policy_a = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap_b = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account_a = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(
        &issuer_cap_b,
        &program_a,
        &policy_a,
        &mut account_a,
        &mut op_shard,
        &mut budget,
        10_000,
        b"op-1",
        &clock,
        ts::ctx(&mut scenario),
    );

    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account_a);
    ts::return_to_sender(&scenario, issuer_cap_b);
    ts::return_immutable(policy_a);
    ts::return_shared(program_a);
    clock::destroy_for_testing(clock);
    ts::end(scenario);
}


// Re-provisioning (OCT-244), the counterpart of the test above: here the
// IssuerCap, program, policy and shards are all the organization's *current*
// ones, and only the member's account predates them. The cap check passes and
// the account's own `program_id` check aborts, with the same `EWrongProgram`
// code. This is the abort `ChainSubmitProcessor.reopenIfStale` recovers from.
#[test, expected_failure(abort_code = 0, location = octap::credit_account)] // credit_account::EWrongProgram
fun earn_rejects_account_opened_in_a_previous_program() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let stale_account_id = ts::most_recent_id_shared<CreditAccount>().destroy_some();
    let (program_b_id, policy_b_id, op_shard_b_id, budget_b_id) = reprovision(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER_B);
    let program_b = ts::take_shared_by_id<ProgramControl>(&scenario, program_b_id);
    let policy_b = ts::take_immutable_by_id<PolicyVersion>(&scenario, policy_b_id);
    let issuer_cap_b = ts::take_from_sender<IssuerCap>(&scenario);
    let mut stale_account = ts::take_shared_by_id<CreditAccount>(&scenario, stale_account_id);
    let mut op_shard_b = ts::take_shared_by_id<OperationShard>(&scenario, op_shard_b_id);
    let mut budget_b = ts::take_shared_by_id<BudgetShard>(&scenario, budget_b_id);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(
        &issuer_cap_b,
        &program_b,
        &policy_b,
        &mut stale_account,
        &mut op_shard_b,
        &mut budget_b,
        10_000,
        b"op-1",
        &clock,
        ts::ctx(&mut scenario),
    );

    ts::return_shared(budget_b);
    ts::return_shared(op_shard_b);
    ts::return_shared(stale_account);
    ts::return_to_sender(&scenario, issuer_cap_b);
    ts::return_immutable(policy_b);
    ts::return_shared(program_b);
    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

// The recovery itself: a new account opened for the same member in the
// current program earns normally, and the stale one is left in the old program.
#[test]
fun account_reopened_in_the_current_program_earns() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let stale_account_id = ts::most_recent_id_shared<CreditAccount>().destroy_some();
    let (program_b_id, policy_b_id, op_shard_b_id, budget_b_id) = reprovision(&mut scenario);

    ts::next_tx(&mut scenario, ISSUER_B);
    let program_b = ts::take_shared_by_id<ProgramControl>(&scenario, program_b_id);
    let issuer_cap_b = ts::take_from_sender<IssuerCap>(&scenario);
    credit_account::open_account(&issuer_cap_b, &program_b, MEMBER, ts::ctx(&mut scenario));
    ts::return_to_sender(&scenario, issuer_cap_b);
    ts::return_shared(program_b);

    ts::next_tx(&mut scenario, ISSUER_B);
    let reopened_id = ts::most_recent_id_shared<CreditAccount>().destroy_some();
    assert!(reopened_id != stale_account_id, 0);
    let program_b = ts::take_shared_by_id<ProgramControl>(&scenario, program_b_id);
    let policy_b = ts::take_immutable_by_id<PolicyVersion>(&scenario, policy_b_id);
    let issuer_cap_b = ts::take_from_sender<IssuerCap>(&scenario);
    let mut reopened = ts::take_shared_by_id<CreditAccount>(&scenario, reopened_id);
    let mut op_shard_b = ts::take_shared_by_id<OperationShard>(&scenario, op_shard_b_id);
    let mut budget_b = ts::take_shared_by_id<BudgetShard>(&scenario, budget_b_id);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(
        &issuer_cap_b,
        &program_b,
        &policy_b,
        &mut reopened,
        &mut op_shard_b,
        &mut budget_b,
        10_000,
        b"op-1",
        &clock,
        ts::ctx(&mut scenario),
    );
    assert!(credit_account::program_id(&reopened) == program_b_id, 1);
    assert!(credit_account::beneficiary(&reopened) == MEMBER, 2);
    assert!(credit_account::spendable(&reopened, &clock) == 100, 3);

    ts::return_shared(budget_b);
    ts::return_shared(op_shard_b);
    ts::return_shared(reopened);
    ts::return_to_sender(&scenario, issuer_cap_b);
    ts::return_immutable(policy_b);
    ts::return_shared(program_b);

    let stale_account = ts::take_shared_by_id<CreditAccount>(&scenario, stale_account_id);
    assert!(credit_account::program_id(&stale_account) != program_b_id, 4);
    ts::return_shared(stale_account);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 1)] // program_control::EPaused
fun earn_rejects_paused_program() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let mut program = ts::take_shared<ProgramControl>(&scenario);
    let admin_cap = ts::take_from_sender<AdminCap>(&scenario);
    program_control::set_paused(&admin_cap, &mut program, true, ts::ctx(&mut scenario));
    ts::return_to_sender(&scenario, admin_cap);
    ts::return_shared(program);

    ts::next_tx(&mut scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(&scenario);
    let policy = ts::take_immutable<PolicyVersion>(&scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(&scenario);
    let mut account = ts::take_shared<CreditAccount>(&scenario);
    let mut op_shard = ts::take_shared<OperationShard>(&scenario);
    let mut budget = ts::take_shared<BudgetShard>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, &mut op_shard, &mut budget, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

/// Runs one `earn` as `ISSUER` against the given shards (taken by id, so
/// multi-shard tests control exactly which shard each earn touches).
fun earn_with_shards(
    scenario: &mut ts::Scenario,
    operation_shard_id: ID,
    budget_shard_id: ID,
    purchase_amount: u64,
    operation_key: vector<u8>,
) {
    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let policy = ts::take_immutable<PolicyVersion>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    let mut account = ts::take_shared<CreditAccount>(scenario);
    let mut op_shard = ts::take_shared_by_id<OperationShard>(scenario, operation_shard_id);
    let mut budget = ts::take_shared_by_id<BudgetShard>(scenario, budget_shard_id);
    let clock = clock::create_for_testing(ts::ctx(scenario));

    credit_account::earn(
        &issuer_cap,
        &program,
        &policy,
        &mut account,
        &mut op_shard,
        &mut budget,
        purchase_amount,
        operation_key,
        &clock,
        ts::ctx(scenario),
    );

    clock::destroy_for_testing(clock);
    ts::return_shared(budget);
    ts::return_shared(op_shard);
    ts::return_shared(account);
    ts::return_to_sender(scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);
}

fun budget_remaining(scenario: &mut ts::Scenario, budget_shard_id: ID): u64 {
    ts::next_tx(scenario, ISSUER);
    let budget = ts::take_shared_by_id<BudgetShard>(scenario, budget_shard_id);
    let remaining = budget_shard::remaining(&budget);
    ts::return_shared(budget);
    remaining
}

#[test, expected_failure(abort_code = 2, location = octap::operation_shard)] // EDuplicateOperation
fun earn_rejects_replayed_operation_key() {
    let mut scenario = ts::begin(ADMIN);
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, DEFAULT_BUDGET, 1);

    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-1");
    // Same key, same account, same shard: the replay must abort on-chain.
    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-1");

    ts::end(scenario);
}

#[test, expected_failure(abort_code = 1, location = octap::operation_shard)] // EWrongShard
fun earn_rejects_operation_shard_that_does_not_own_the_key() {
    let mut scenario = ts::begin(ADMIN);
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, DEFAULT_BUDGET, 2);

    // sha2_256("op-1") routes to shard 1 of 2; accepting shard 0 would let a replay of "op-1"
    // dodge the shard that already recorded it, so it must abort.
    earn_with_shards(&mut scenario, op_ids[0], budget_ids[1], 10_000, b"op-1");

    ts::end(scenario);
}

#[test, expected_failure(abort_code = 2, location = octap::budget_shard)] // EBudgetExceeded
fun earn_rejects_overdrawing_budget_shard() {
    let mut scenario = ts::begin(ADMIN);
    // 150 total over 1 shard; each 10_000-unit purchase earns 100 credits.
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, 150, 1);

    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-1");
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 50, 0);
    // 100 more would take the shard to -50.
    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-2");

    ts::end(scenario);
}

#[test]
fun budget_shards_are_debited_independently() {
    let mut scenario = ts::begin(ADMIN);
    // 301 over 2 shards: shard 0 gets 150 plus the remainder 1, shard 1 gets 150.
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, 301, 2);
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 151, 0);
    assert!(budget_remaining(&mut scenario, budget_ids[1]) == 150, 1);

    // "op-1" -> shard 1, "op-4" -> shard 0 (sha2_256 first 8 bytes big-endian, mod 2).
    assert!(operation_shard::shard_index_for(&b"op-1", 2) == 1, 2);
    assert!(operation_shard::shard_index_for(&b"op-4", 2) == 0, 3);

    earn_with_shards(&mut scenario, op_ids[1], budget_ids[1], 10_000, b"op-1");
    assert!(budget_remaining(&mut scenario, budget_ids[1]) == 50, 4);
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 151, 5);

    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-4");
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 51, 6);
    assert!(budget_remaining(&mut scenario, budget_ids[1]) == 50, 7);

    ts::end(scenario);
}

#[test, expected_failure(abort_code = 2, location = octap::budget_shard)] // EBudgetExceeded
fun drained_budget_shard_does_not_borrow_from_its_sibling() {
    let mut scenario = ts::begin(ADMIN);
    // 200 over 2 shards: 100 each, so shard 1 can fund exactly one 100-credit earn.
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, 200, 2);

    earn_with_shards(&mut scenario, op_ids[1], budget_ids[1], 10_000, b"op-1");
    assert!(budget_remaining(&mut scenario, budget_ids[1]) == 0, 0);
    // "op-2" also routes to shard 1; shard 0 still holds 100 but must not be drawn on.
    earn_with_shards(&mut scenario, op_ids[1], budget_ids[1], 10_000, b"op-2");

    ts::end(scenario);
}

/// Tops up `budget_shard_id` by `amount` as `ADMIN`, with the program's own `AdminCap`.
fun top_up_as_admin(scenario: &mut ts::Scenario, budget_shard_id: ID, amount: u64) {
    ts::next_tx(scenario, ADMIN);
    let admin_cap = ts::take_from_sender<AdminCap>(scenario);
    let mut budget = ts::take_shared_by_id<BudgetShard>(scenario, budget_shard_id);
    budget_shard::top_up(&admin_cap, &mut budget, amount, ts::ctx(scenario));
    ts::return_shared(budget);
    ts::return_to_sender(scenario, admin_cap);
}

#[test]
fun top_up_refills_a_drained_shard_so_earn_works_again() {
    let mut scenario = ts::begin(ADMIN);
    // 100 total over 1 shard: exactly one 100-credit earn drains it.
    let (op_ids, budget_ids) = setup_with_shards(&mut scenario, 100, 1);
    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-1");
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 0, 0);

    top_up_as_admin(&mut scenario, budget_ids[0], 250);
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 250, 1);

    // The earn that a drained shard would have rejected (`EBudgetExceeded`) now succeeds.
    earn_with_shards(&mut scenario, op_ids[0], budget_ids[0], 10_000, b"op-2");
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 150, 2);

    ts::end(scenario);
}

#[test]
fun top_up_only_touches_the_given_shard() {
    let mut scenario = ts::begin(ADMIN);
    let (_op_ids, budget_ids) = setup_with_shards(&mut scenario, 200, 2);

    top_up_as_admin(&mut scenario, budget_ids[1], 40);
    assert!(budget_remaining(&mut scenario, budget_ids[0]) == 100, 0);
    assert!(budget_remaining(&mut scenario, budget_ids[1]) == 140, 1);

    ts::end(scenario);
}

#[test, expected_failure(abort_code = 0, location = octap::budget_shard)] // EWrongProgram
fun top_up_rejects_admin_cap_of_a_different_program() {
    let mut scenario = ts::begin(ADMIN);
    let (_op_ids, budget_ids) = setup_with_shards(&mut scenario, 100, 1);

    // A second program's AdminCap, held by OTHER: a real AdminCap, just not this program's.
    // (An IssuerCap can't even be passed here — `top_up` takes `&AdminCap`.)
    let admin_cap_b = program_control::create_program(ts::ctx(&mut scenario));
    transfer::public_transfer(admin_cap_b, OTHER);

    ts::next_tx(&mut scenario, OTHER);
    let admin_cap_b = ts::take_from_sender<AdminCap>(&scenario);
    let mut budget = ts::take_shared_by_id<BudgetShard>(&scenario, budget_ids[0]);
    budget_shard::top_up(&admin_cap_b, &mut budget, 1_000, ts::ctx(&mut scenario));

    ts::return_shared(budget);
    ts::return_to_sender(&scenario, admin_cap_b);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = 4, location = octap::budget_shard)] // EZeroTopUp
fun top_up_rejects_zero_amount() {
    let mut scenario = ts::begin(ADMIN);
    let (_op_ids, budget_ids) = setup_with_shards(&mut scenario, 100, 1);
    top_up_as_admin(&mut scenario, budget_ids[0], 0);
    ts::end(scenario);
}

/// Cross-language fixture: `ts-sdks/packages/chain` asserts the same
/// key/count -> index pairs, so Move and TS shard routing can't drift.
#[test]
fun shard_index_matches_shared_fixture() {
    assert!(operation_shard::shard_index_for(&b"earn:fixture-shard-key", 7) == 4, 0);
    assert!(operation_shard::shard_index_for(&b"op-1", 16) == 5, 1);
    assert!(operation_shard::shard_index_for(&b"op-5", 1) == 0, 2);
}
