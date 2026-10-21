import { createHash } from 'node:crypto';

/**
 * Which of a program's `shardCount` operation/budget shards owns `operationKey`. Must match
 * `octap::operation_shard::shard_index_for` byte-for-byte — passing any other shard to `earn`
 * aborts on-chain with `EWrongShard`:
 *
 *   sha2_256(operationKey), first 8 bytes read as a big-endian u64, mod shardCount.
 *
 * `contracts/sui/tests/credit_account_tests.move`'s `shard_index_matches_shared_fixture` and
 * `scripts/test-unit.mjs` assert the same key/count -> index fixtures, so the two can't drift.
 */
export function operationShardIndex(operationKey: Uint8Array, shardCount: number): number {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
    throw new Error(`shardCount must be a positive integer, got ${shardCount}`);
  }
  const prefix = createHash('sha256').update(operationKey).digest().readBigUInt64BE(0);
  return Number(prefix % BigInt(shardCount));
}
