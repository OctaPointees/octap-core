/// On-chain anti-replay for `credit_account::earn`. Every `operation_key`
/// a program has ever earned under is recorded in exactly one of the
/// program's `OperationShard`s, so a replayed key aborts on-chain even if
/// it somehow got past PostgreSQL's idempotency key.
///
/// Sharded rather than one shared table so that concurrent earns with
/// different keys mostly touch different shared objects instead of all
/// contending on a single hot one. Which shard owns a key is a pure
/// function of the key (`shard_index_for`), so a caller can't pick a
/// fresh shard to slip a replay past the check: passing any shard but the
/// owning one aborts `EWrongShard`.
///
/// Shard index convention (the TS SDK's `operationShardIndex` must match
/// this byte-for-byte): `sha2_256(operation_key)`, first 8 bytes read as
/// a big-endian u64, mod `shard_count`.
///
/// Each recorded key keeps what its earn did (account, credited amount,
/// bucket) so `credit_account::reverse_earn` can undo exactly that earn,
/// at most once (`mark_reversed`). Recording and reversing are
/// `public(package)`: a shard is a shared object, so a public `&mut` entry
/// would let anyone pre-record a key and block the real earn.
module octap::operation_shard;

use octap::capabilities::{Self, AdminCap};
use sui::event;
use sui::table::{Self, Table};
use std::hash;

const EWrongProgram: u64 = 0;
const EWrongShard: u64 = 1;
const EDuplicateOperation: u64 = 2;
const EZeroShardCount: u64 = 3;
const EUnknownOperation: u64 = 4;
const EAlreadyReversed: u64 = 5;

public struct OperationShard has key {
    id: UID,
    program_id: ID,
    shard_index: u64,
    shard_count: u64,
    seen: Table<vector<u8>, EarnRecord>,
}

/// What one recorded `earn` did, kept so it can be reversed exactly.
public struct EarnRecord has store, drop {
    account_id: ID,
    amount: u64,
    bucket_seq: u64,
    reversed: bool,
}

public struct OperationShardCreated has copy, drop {
    program_id: ID,
    shard_id: ID,
    shard_index: u64,
    shard_count: u64,
}

/// Creates and shares `shard_count` shards for `program_id`, returning
/// their ids in shard-index order so a provisioning transaction (or a
/// test) can map index -> object id without scanning events.
public fun create_shards(admin: &AdminCap, program_id: ID, shard_count: u64, ctx: &mut TxContext): vector<ID> {
    assert!(capabilities::admin_program_id(admin) == program_id, EWrongProgram);
    assert!(shard_count > 0, EZeroShardCount);

    let mut ids = vector[];
    let mut shard_index = 0;
    while (shard_index < shard_count) {
        let shard = OperationShard {
            id: object::new(ctx),
            program_id,
            shard_index,
            shard_count,
            seen: table::new(ctx),
        };
        let shard_id = object::id(&shard);
        event::emit(OperationShardCreated { program_id, shard_id, shard_index, shard_count });
        vector::push_back(&mut ids, shard_id);
        transfer::share_object(shard);
        shard_index = shard_index + 1;
    };
    ids
}

/// Aborts unless `shard` is `program_id`'s owning shard for
/// `operation_key` and the key has never been recorded; then records it
/// together with what the earn did.
public(package) fun check_and_record(
    shard: &mut OperationShard,
    program_id: ID,
    operation_key: vector<u8>,
    account_id: ID,
    amount: u64,
    bucket_seq: u64,
) {
    assert_owning_shard(shard, program_id, &operation_key);
    assert!(!table::contains(&shard.seen, operation_key), EDuplicateOperation);
    table::add(&mut shard.seen, operation_key, EarnRecord { account_id, amount, bucket_seq, reversed: false });
}

/// Marks a recorded earn reversed and returns its `(account_id, amount,
/// bucket_seq)`. Aborts `EUnknownOperation` for a key never earned under
/// and `EAlreadyReversed` for the second reversal of the same key.
public(package) fun mark_reversed(shard: &mut OperationShard, program_id: ID, operation_key: vector<u8>): (ID, u64, u64) {
    assert_owning_shard(shard, program_id, &operation_key);
    assert!(table::contains(&shard.seen, operation_key), EUnknownOperation);
    let record = table::borrow_mut(&mut shard.seen, operation_key);
    assert!(!record.reversed, EAlreadyReversed);
    record.reversed = true;
    (record.account_id, record.amount, record.bucket_seq)
}

fun assert_owning_shard(shard: &OperationShard, program_id: ID, operation_key: &vector<u8>) {
    assert!(shard.program_id == program_id, EWrongProgram);
    assert!(shard_index_for(operation_key, shard.shard_count) == shard.shard_index, EWrongShard);
}

/// The shard that owns `operation_key` out of `shard_count`. See the
/// module doc for the exact byte-order convention.
public fun shard_index_for(operation_key: &vector<u8>, shard_count: u64): u64 {
    assert!(shard_count > 0, EZeroShardCount);
    let digest = hash::sha2_256(*operation_key);
    let mut value = 0u64;
    let mut i = 0;
    while (i < 8) {
        value = (value << 8) | (*vector::borrow(&digest, i) as u64);
        i = i + 1;
    };
    value % shard_count
}

public fun program_id(shard: &OperationShard): ID {
    shard.program_id
}

public fun shard_index(shard: &OperationShard): u64 {
    shard.shard_index
}

public fun shard_count(shard: &OperationShard): u64 {
    shard.shard_count
}

public fun has_seen(shard: &OperationShard, operation_key: vector<u8>): bool {
    table::contains(&shard.seen, operation_key)
}

public fun is_reversed(shard: &OperationShard, operation_key: vector<u8>): bool {
    table::contains(&shard.seen, operation_key) && table::borrow(&shard.seen, operation_key).reversed
}
