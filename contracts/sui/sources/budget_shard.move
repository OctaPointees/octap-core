/// A program's total issuance budget, split across `shard_count` shared
/// objects so concurrent earns don't all contend on one balance. Each
/// shard is debited independently and can never go negative; a shard
/// running dry does not borrow from its siblings.
///
/// Shard selection deliberately reuses `operation_shard`'s index for the
/// same `operation_key` instead of load-balancing budget shards on their
/// own: it keeps the caller to one hash computation. That's a documented
/// simplification — it means a program's operation and budget shard
/// counts should match, and a hot key range drains its budget shard
/// first.
///
/// A drained shard is refilled by the program's `AdminCap` holder with
/// `top_up`. `debit` and `refund` are `public(package)`: only
/// `credit_account::earn`/`reverse_earn` move budget, since a public `&mut`
/// function on a shared shard would let anyone drain it.
module octap::budget_shard;

use octap::capabilities::{Self, AdminCap};
use octap::operation_shard;
use sui::event;

const EWrongProgram: u64 = 0;
const EWrongShard: u64 = 1;
const EBudgetExceeded: u64 = 2;
const EZeroShardCount: u64 = 3;
const EZeroTopUp: u64 = 4;

public struct BudgetShard has key {
    id: UID,
    program_id: ID,
    shard_index: u64,
    shard_count: u64,
    remaining: u64,
}

public struct BudgetShardCreated has copy, drop {
    program_id: ID,
    shard_id: ID,
    shard_index: u64,
    shard_count: u64,
    allocated: u64,
}

public struct BudgetDebited has copy, drop {
    program_id: ID,
    shard_id: ID,
    amount: u64,
    remaining: u64,
}

public struct BudgetRefunded has copy, drop {
    program_id: ID,
    shard_id: ID,
    amount: u64,
    remaining: u64,
}

public struct BudgetToppedUp has copy, drop {
    program_id: ID,
    shard_id: ID,
    amount: u64,
    remaining: u64,
}

/// Creates and shares `shard_count` shards for `program_id`, splitting
/// `total_budget` evenly with the division remainder going to shard 0.
/// Returns the shard ids in shard-index order.
public fun create_shards(
    admin: &AdminCap,
    program_id: ID,
    total_budget: u64,
    shard_count: u64,
    ctx: &mut TxContext,
): vector<ID> {
    assert!(capabilities::admin_program_id(admin) == program_id, EWrongProgram);
    assert!(shard_count > 0, EZeroShardCount);

    let per_shard = total_budget / shard_count;
    let remainder = total_budget % shard_count;
    let mut ids = vector[];
    let mut shard_index = 0;
    while (shard_index < shard_count) {
        let allocated = if (shard_index == 0) { per_shard + remainder } else { per_shard };
        let shard = BudgetShard {
            id: object::new(ctx),
            program_id,
            shard_index,
            shard_count,
            remaining: allocated,
        };
        let shard_id = object::id(&shard);
        event::emit(BudgetShardCreated { program_id, shard_id, shard_index, shard_count, allocated });
        vector::push_back(&mut ids, shard_id);
        transfer::share_object(shard);
        shard_index = shard_index + 1;
    };
    ids
}

/// Debits `amount` from the shard that owns `operation_key`. Aborts
/// `EWrongShard` for any other shard, so a caller can't drain whichever
/// shard still has budget left.
public(package) fun debit(shard: &mut BudgetShard, program_id: ID, operation_key: &vector<u8>, amount: u64) {
    assert_owning_shard(shard, program_id, operation_key);
    assert!(amount <= shard.remaining, EBudgetExceeded);

    shard.remaining = shard.remaining - amount;
    event::emit(BudgetDebited {
        program_id,
        shard_id: object::id(shard),
        amount,
        remaining: shard.remaining,
    });
}

/// Gives a reversed earn's `amount` back to the shard that owns its
/// `operation_key` — the same shard `debit` took it from.
public(package) fun refund(shard: &mut BudgetShard, program_id: ID, operation_key: &vector<u8>, amount: u64) {
    assert_owning_shard(shard, program_id, operation_key);

    shard.remaining = shard.remaining + amount;
    event::emit(BudgetRefunded {
        program_id,
        shard_id: object::id(shard),
        amount,
        remaining: shard.remaining,
    });
}

fun assert_owning_shard(shard: &BudgetShard, program_id: ID, operation_key: &vector<u8>) {
    assert!(shard.program_id == program_id, EWrongProgram);
    assert!(operation_shard::shard_index_for(operation_key, shard.shard_count) == shard.shard_index, EWrongShard);
}

/// Adds `amount` to one shard's remaining budget. Only the program's
/// `AdminCap` can do this, and only for its own program's shards; the
/// amount isn't redistributed across siblings, so a caller refilling a
/// multi-shard program tops up each shard it wants refilled.
entry fun top_up(admin: &AdminCap, shard: &mut BudgetShard, amount: u64, _ctx: &mut TxContext) {
    assert!(capabilities::admin_program_id(admin) == shard.program_id, EWrongProgram);
    assert!(amount > 0, EZeroTopUp);

    shard.remaining = shard.remaining + amount;
    event::emit(BudgetToppedUp {
        program_id: shard.program_id,
        shard_id: object::id(shard),
        amount,
        remaining: shard.remaining,
    });
}

public fun program_id(shard: &BudgetShard): ID {
    shard.program_id
}

public fun shard_index(shard: &BudgetShard): u64 {
    shard.shard_index
}

public fun shard_count(shard: &BudgetShard): u64 {
    shard.shard_count
}

public fun remaining(shard: &BudgetShard): u64 {
    shard.remaining
}
