#[test_only]
module octap::credit_account_tests;

use sui::test_scenario as ts;
use sui::clock;
use octap::capabilities::{AdminCap, IssuerCap};
use octap::program_control::{Self, ProgramControl};
use octap::policy_version::{Self, PolicyVersion};
use octap::credit_account::{Self, CreditAccount};

const ADMIN: address = @0xA;
const ISSUER: address = @0xB;
const MEMBER: address = @0xC;
const OTHER: address = @0xD;
const ISSUER_B: address = @0xE;
const DAY_MS: u64 = 86_400_000;

/// Builds a program with an activated 100-bps / 1-day-expiry policy and an
/// IssuerCap sent to `ISSUER`, leaving the scenario positioned right after
/// that setup so each test only has to open an account and act.
fun setup(scenario: &mut ts::Scenario) {
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
    ts::return_immutable(policy);
    ts::return_shared(program);
    ts::return_to_sender(scenario, admin_cap);

    ts::next_tx(scenario, ISSUER);
    let program = ts::take_shared<ProgramControl>(scenario);
    let issuer_cap = ts::take_from_sender<IssuerCap>(scenario);
    credit_account::open_account(&issuer_cap, &program, MEMBER, ts::ctx(scenario));
    ts::return_shared(program);
    ts::return_to_sender(scenario, issuer_cap);
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
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    // 10_000-unit purchase at 100 bps (1%) earns 100 credits.
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    assert!(credit_account::spendable(&account, &clock) == 100, 0);

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
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
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
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
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
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(&issuer_cap, &program, &policy, &mut account, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    assert!(credit_account::spendable(&account, &clock) == 100, 0);

    // Past the 1-day expiry window: the bucket must no longer count.
    clock::increment_for_testing(&mut clock, DAY_MS + 1);
    assert!(credit_account::spendable(&account, &clock) == 0, 1);

    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
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
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));

    credit_account::earn(
        &issuer_cap_b,
        &program_a,
        &policy_a,
        &mut account_a,
        10_000,
        b"op-1",
        &clock,
        ts::ctx(&mut scenario),
    );

    ts::return_shared(account_a);
    ts::return_to_sender(&scenario, issuer_cap_b);
    ts::return_immutable(policy_a);
    ts::return_shared(program_a);
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
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    credit_account::earn(&issuer_cap, &program, &policy, &mut account, 10_000, b"op-1", &clock, ts::ctx(&mut scenario));
    ts::return_shared(account);
    ts::return_to_sender(&scenario, issuer_cap);
    ts::return_immutable(policy);
    ts::return_shared(program);

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}
