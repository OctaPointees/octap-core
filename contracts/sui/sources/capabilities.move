/// Capability objects for the OctaP credit program. Capabilities carry no
/// state beyond the program they are scoped to; all business rules live in
/// the modules that consume them.
module octap::capabilities;

/// Held by the organization's platform-side administrator. Can create a
/// program, publish and activate policy versions, pause/unpause the
/// program, and mint `IssuerCap`s for it. Must never be held by an API
/// worker signer — only by the org's admin-controlled key.
public struct AdminCap has key, store {
    id: UID,
    program_id: ID,
}

/// Held by a backend service signer authorized to earn credits into
/// accounts under one program. Scoped to exactly one program; carries no
/// admin rights (cannot pause, rotate policy, or mint other caps).
public struct IssuerCap has key, store {
    id: UID,
    program_id: ID,
}

/// Restricted to this package: only `program_control` mints capabilities,
/// so every cap in existence is traceable to a real `create_program` or
/// `issue_cap` call.
public(package) fun new_admin_cap(program_id: ID, ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx), program_id }
}

public(package) fun new_issuer_cap(program_id: ID, ctx: &mut TxContext): IssuerCap {
    IssuerCap { id: object::new(ctx), program_id }
}

public fun admin_program_id(cap: &AdminCap): ID {
    cap.program_id
}

public fun issuer_program_id(cap: &IssuerCap): ID {
    cap.program_id
}
