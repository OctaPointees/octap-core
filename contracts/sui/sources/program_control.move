/// `ProgramControl` is the shared root object for one organization's credit
/// program: it is the on-chain identity every capability, policy, and
/// credit account is checked against, and the single switch that pauses a
/// program or rotates its active policy. Program admins invoke this
/// module directly; issuers and beneficiaries only ever read it.
module octap::program_control;

use octap::capabilities::{Self, AdminCap};
use octap::policy_version::{Self, PolicyVersion};
use sui::event;

const EWrongProgram: u64 = 0;
const EPaused: u64 = 1;
const ENoActivePolicy: u64 = 2;
const EPolicyNotActive: u64 = 3;

public struct ProgramControl has key {
    id: UID,
    active_policy_version: Option<ID>,
    paused: bool,
}

public struct ProgramCreated has copy, drop {
    program_id: ID,
    admin_cap_id: ID,
}

public struct PolicyActivated has copy, drop {
    program_id: ID,
    policy_version_id: ID,
}

public struct ProgramPauseToggled has copy, drop {
    program_id: ID,
    paused: bool,
}

public struct IssuerCapIssued has copy, drop {
    program_id: ID,
    issuer_cap_id: ID,
    recipient: address,
}

/// Creates a new program and mints its `AdminCap` to the caller. The
/// program starts paused-off but with no active policy: `earn` aborts
/// until `activate_policy` is called, so a program can be fully
/// provisioned (policy published, reviewed) before it can move credits.
public fun create_program(ctx: &mut TxContext): AdminCap {
    let program = ProgramControl {
        id: object::new(ctx),
        active_policy_version: option::none(),
        paused: false,
    };
    let program_id = object::id(&program);
    let admin_cap = capabilities::new_admin_cap(program_id, ctx);

    event::emit(ProgramCreated { program_id, admin_cap_id: object::id(&admin_cap) });
    transfer::share_object(program);
    admin_cap
}

entry fun create_program_entry(ctx: &mut TxContext) {
    let admin_cap = create_program(ctx);
    transfer::public_transfer(admin_cap, tx_context::sender(ctx));
}

public fun assert_same_program(program: &ProgramControl, program_id: ID) {
    assert!(object::id(program) == program_id, EWrongProgram);
}

public fun assert_active(program: &ProgramControl) {
    assert!(!program.paused, EPaused);
}

/// Aborts unless `policy` is both scoped to `program` and currently the
/// program's active policy version — the on-chain enforcement behind
/// "policy must be active, not paused, and valid" (registration invariant).
public fun assert_policy_active(program: &ProgramControl, policy: &PolicyVersion) {
    assert_active(program);
    assert_same_program(program, policy_version::program_id(policy));
    assert!(option::is_some(&program.active_policy_version), ENoActivePolicy);
    let active_id = *option::borrow(&program.active_policy_version);
    assert!(active_id == object::id(policy), EPolicyNotActive);
}

entry fun activate_policy(
    admin: &AdminCap,
    program: &mut ProgramControl,
    policy: &PolicyVersion,
    _ctx: &mut TxContext,
) {
    assert_same_program(program, capabilities::admin_program_id(admin));
    assert_same_program(program, policy_version::program_id(policy));

    program.active_policy_version = option::some(object::id(policy));
    event::emit(PolicyActivated { program_id: object::id(program), policy_version_id: object::id(policy) });
}

entry fun set_paused(admin: &AdminCap, program: &mut ProgramControl, paused: bool, _ctx: &mut TxContext) {
    assert_same_program(program, capabilities::admin_program_id(admin));

    program.paused = paused;
    event::emit(ProgramPauseToggled { program_id: object::id(program), paused });
}

/// Mints a new `IssuerCap` for this program and sends it to `recipient`
/// (the address backing the service signer that will call `earn`).
entry fun issue_cap(admin: &AdminCap, program: &ProgramControl, recipient: address, ctx: &mut TxContext) {
    assert_same_program(program, capabilities::admin_program_id(admin));

    let issuer_cap = capabilities::new_issuer_cap(object::id(program), ctx);
    event::emit(IssuerCapIssued {
        program_id: object::id(program),
        issuer_cap_id: object::id(&issuer_cap),
        recipient,
    });
    transfer::public_transfer(issuer_cap, recipient);
}
