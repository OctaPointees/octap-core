#[test_only]
module octap_audit::evidence_seal_tests;

use sui::test_scenario as ts;
use sui::clock::{Self, Clock};
use octap_audit::evidence_seal::{Self, EvidenceSeal, SealRegistry, SealerCap};

const SEALER: address = @0xA;
const DAY_MS: u64 = 86_400_000;

fun org(): vector<u8> { b"0b6c2f1e-1111-4222-8333-444455556666" }

fun hash(byte: u8): vector<u8> {
    let mut h = vector[];
    let mut i = 0;
    while (i < 32) {
        h.push_back(byte);
        i = i + 1;
    };
    h
}

fun setup(scenario: &mut ts::Scenario): Clock {
    evidence_seal::init_for_testing(ts::ctx(scenario));
    let mut clock = clock::create_for_testing(ts::ctx(scenario));
    clock.set_for_testing(10 * DAY_MS);
    ts::next_tx(scenario, SEALER);
    clock
}

fun seal(
    scenario: &mut ts::Scenario,
    clock: &Clock,
    start: u64,
    end: u64,
    manifest: vector<u8>,
    previous: vector<u8>,
) {
    let cap = ts::take_from_sender<SealerCap>(scenario);
    let mut registry = ts::take_shared<SealRegistry>(scenario);
    evidence_seal::seal(&cap, &mut registry, org(), start, end, manifest, previous, clock, ts::ctx(scenario));
    ts::return_shared(registry);
    ts::return_to_sender(scenario, cap);
    ts::next_tx(scenario, SEALER);
}

#[test]
fun seals_contiguous_periods_and_freezes_each_seal() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);

    seal(&mut scenario, &clock, 0, DAY_MS, hash(1), vector[]);
    let first = ts::take_immutable<EvidenceSeal>(&scenario);
    assert!(first.manifest_hash() == hash(1));
    assert!(first.previous_manifest_hash().is_empty());
    assert!(first.period_start_ms() == 0 && first.period_end_ms() == DAY_MS);
    assert!(first.sealed_at_ms() == 10 * DAY_MS);
    assert!(first.organization_id() == org());
    let first_id = object::id(&first);
    ts::return_immutable(first);

    let registry = ts::take_shared<SealRegistry>(&scenario);
    assert!(evidence_seal::latest_seal_id(&registry, org()) == option::some(first_id));
    assert!(evidence_seal::latest_seal_id(&registry, b"other").is_none());
    ts::return_shared(registry);
    ts::next_tx(&mut scenario, SEALER);

    // The next period starts exactly where the first ended.
    seal(&mut scenario, &clock, DAY_MS, 2 * DAY_MS, hash(2), hash(1));
    let registry = ts::take_shared<SealRegistry>(&scenario);
    assert!(evidence_seal::latest_seal_id(&registry, org()) != option::some(first_id));
    ts::return_shared(registry);

    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::ENotContiguous)]
fun refuses_a_period_before_the_latest_seal() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, DAY_MS, 2 * DAY_MS, hash(1), vector[]);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(2), hash(1));
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::ENotContiguous)]
fun refuses_to_seal_the_same_period_again() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(1), vector[]);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(2), hash(1));
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::EWrongPrevious)]
fun refuses_a_seal_that_skips_its_previous_hash() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(1), vector[]);
    seal(&mut scenario, &clock, DAY_MS, 2 * DAY_MS, hash(2), hash(9));
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::EWrongPrevious)]
fun refuses_a_previous_hash_on_the_first_seal() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(1), hash(9));
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::EPeriodNotOver)]
fun refuses_a_period_that_is_not_over() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 10 * DAY_MS, 11 * DAY_MS, hash(1), vector[]);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::EInvalidHash)]
fun refuses_a_hash_that_is_not_sha256() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 0, DAY_MS, b"short", vector[]);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::EInvalidPeriod)]
fun refuses_an_empty_period() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, DAY_MS, DAY_MS, hash(1), vector[]);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = evidence_seal::ENotContiguous)]
fun refuses_to_skip_a_period() {
    let mut scenario = ts::begin(SEALER);
    let clock = setup(&mut scenario);
    seal(&mut scenario, &clock, 0, DAY_MS, hash(1), vector[]);
    seal(&mut scenario, &clock, 2 * DAY_MS, 3 * DAY_MS, hash(2), hash(1));
    clock.destroy_for_testing();
    ts::end(scenario);
}
