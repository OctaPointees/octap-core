/// An immutable, versioned earn rule for one program. Publishing a new
/// version never edits an old one — `program_control::activate_policy`
/// is the only thing that changes which version is enforced, so history
/// stays auditable.
module octap::policy_version;

use octap::capabilities::{Self, AdminCap};
use sui::event;

const EWrongProgram: u64 = 0;

public struct PolicyVersion has key {
    id: UID,
    program_id: ID,
    version: u64,
    /// Credits earned per 10_000 units of purchase amount (basis points),
    /// e.g. 100 = 1 credit per 100 units spent.
    earn_bps: u64,
    /// How long, in milliseconds from the moment of earning, a bucket of
    /// credits minted under this policy stays spendable.
    expiry_ms: u64,
}

public struct PolicyPublished has copy, drop {
    program_id: ID,
    policy_version_id: ID,
    version: u64,
    earn_bps: u64,
    expiry_ms: u64,
}

/// Publishes and permanently freezes a new policy version for `program_id`.
/// Freezing (rather than a shared, admin-writable object) is what makes
/// "immutable post-publish" an on-chain guarantee instead of a convention.
entry fun publish(
    admin: &AdminCap,
    program_id: ID,
    version: u64,
    earn_bps: u64,
    expiry_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(capabilities::admin_program_id(admin) == program_id, EWrongProgram);

    let policy = PolicyVersion {
        id: object::new(ctx),
        program_id,
        version,
        earn_bps,
        expiry_ms,
    };
    event::emit(PolicyPublished {
        program_id,
        policy_version_id: object::id(&policy),
        version,
        earn_bps,
        expiry_ms,
    });
    transfer::freeze_object(policy);
}

public fun program_id(policy: &PolicyVersion): ID {
    policy.program_id
}

public fun version(policy: &PolicyVersion): u64 {
    policy.version
}

public fun earn_bps(policy: &PolicyVersion): u64 {
    policy.earn_bps
}

public fun expiry_ms(policy: &PolicyVersion): u64 {
    policy.expiry_ms
}
