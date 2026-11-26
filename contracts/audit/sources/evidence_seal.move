/// Seals of an organization's audit evidence (OCT-77).
///
/// Core closes each organization's evidence period (its confirmed ledger
/// facts and audit log rows), hashes it into a manifest, and seals that hash
/// here. A seal is frozen, so nobody can edit or delete it, OctaP included.
/// The chain's clock stamps when it was sealed, so a seal can't be backdated.
///
/// The registry keeps each organization's latest seal and enforces the chain
/// of periods on-chain. A seal must name the previous seal's manifest hash,
/// and it must start where that seal ended or later. So a sealed period can't
/// be sealed again or replaced, and no period can be inserted before the
/// latest one. Days with no activity are skipped: a later seal may start
/// after a gap.
///
/// This is its own package, apart from `octap`, so that it is published once
/// and never forces a fresh `octap` publish or a re-provision of every program.
module octap_audit::evidence_seal;

use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

const EInvalidHash: u64 = 0;
const EInvalidPeriod: u64 = 1;
const EPeriodNotOver: u64 = 2;
const EOutOfOrder: u64 = 3;
const EWrongPrevious: u64 = 4;
const EInvalidOrganization: u64 = 5;

/// A sha256 digest.
const HASH_LENGTH: u64 = 32;

/// Authorizes sealing. Minted once to the publisher, then held by Core's
/// sealing signer. Whoever holds it is the only one who can create an
/// `EvidenceSeal`, so the type alone proves who sealed it.
public struct SealerCap has key, store {
    id: UID,
}

/// Shared. Each organization's latest seal, keyed by its organization id
/// (the UUID's text bytes).
public struct SealRegistry has key {
    id: UID,
    latest: Table<vector<u8>, Latest>,
}

public struct Latest has copy, drop, store {
    seal_id: ID,
    period_end_ms: u64,
    manifest_hash: vector<u8>,
}

/// One sealed evidence period. Frozen when created.
public struct EvidenceSeal has key {
    id: UID,
    /// The organization's id as UUID text, e.g. `0b6c…-…`.
    organization_id: vector<u8>,
    period_start_ms: u64,
    period_end_ms: u64,
    /// sha256 of the period's canonical manifest.
    manifest_hash: vector<u8>,
    /// The organization's previous seal's manifest hash. Empty on its first.
    previous_manifest_hash: vector<u8>,
    sealed_at_ms: u64,
}

public struct EvidenceSealed has copy, drop {
    seal_id: ID,
    organization_id: vector<u8>,
    period_start_ms: u64,
    period_end_ms: u64,
    manifest_hash: vector<u8>,
    previous_manifest_hash: vector<u8>,
    sealed_at_ms: u64,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(SealRegistry { id: object::new(ctx), latest: table::new(ctx) });
    transfer::transfer(SealerCap { id: object::new(ctx) }, ctx.sender());
}

/// Seals one evidence period of `organization_id`. The period must be over,
/// and it must follow the organization's latest seal, naming that seal's
/// manifest hash as `previous_manifest_hash` (empty on the first seal).
entry fun seal(
    _: &SealerCap,
    registry: &mut SealRegistry,
    organization_id: vector<u8>,
    period_start_ms: u64,
    period_end_ms: u64,
    manifest_hash: vector<u8>,
    previous_manifest_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!organization_id.is_empty(), EInvalidOrganization);
    assert!(manifest_hash.length() == HASH_LENGTH, EInvalidHash);
    assert!(period_start_ms < period_end_ms, EInvalidPeriod);
    let now = clock.timestamp_ms();
    assert!(period_end_ms <= now, EPeriodNotOver);

    if (registry.latest.contains(organization_id)) {
        let latest = &registry.latest[organization_id];
        assert!(period_start_ms >= latest.period_end_ms, EOutOfOrder);
        assert!(previous_manifest_hash == latest.manifest_hash, EWrongPrevious);
    } else {
        assert!(previous_manifest_hash.is_empty(), EWrongPrevious);
    };

    let seal = EvidenceSeal {
        id: object::new(ctx),
        organization_id,
        period_start_ms,
        period_end_ms,
        manifest_hash,
        previous_manifest_hash,
        sealed_at_ms: now,
    };
    let seal_id = object::id(&seal);
    let latest = Latest { seal_id, period_end_ms, manifest_hash };
    if (registry.latest.contains(organization_id)) {
        *&mut registry.latest[organization_id] = latest;
    } else {
        registry.latest.add(organization_id, latest);
    };
    event::emit(EvidenceSealed {
        seal_id,
        organization_id: seal.organization_id,
        period_start_ms,
        period_end_ms,
        manifest_hash: seal.manifest_hash,
        previous_manifest_hash: seal.previous_manifest_hash,
        sealed_at_ms: now,
    });
    transfer::freeze_object(seal);
}

/// The organization's latest seal, if it has one.
public fun latest_seal_id(registry: &SealRegistry, organization_id: vector<u8>): Option<ID> {
    if (registry.latest.contains(organization_id)) option::some(registry.latest[organization_id].seal_id)
    else option::none()
}

public fun organization_id(seal: &EvidenceSeal): vector<u8> { seal.organization_id }

public fun period_start_ms(seal: &EvidenceSeal): u64 { seal.period_start_ms }

public fun period_end_ms(seal: &EvidenceSeal): u64 { seal.period_end_ms }

public fun manifest_hash(seal: &EvidenceSeal): vector<u8> { seal.manifest_hash }

public fun previous_manifest_hash(seal: &EvidenceSeal): vector<u8> { seal.previous_manifest_hash }

public fun sealed_at_ms(seal: &EvidenceSeal): u64 { seal.sealed_at_ms }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}
