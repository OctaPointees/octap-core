import { describe, expect, it } from 'vitest';
import {
  OperationPayloadConflictError,
  acceptCommand,
  hashPayload,
} from '#infra/db/repositories/operations.repository.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';

/** Just enough of a drizzle transaction for `acceptCommand`'s read/update/insert paths. */
function fakeCommandTx(existing: Record<string, unknown> | undefined) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const tx = {
    query: { operations: { findFirst: async () => existing } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            return [{ ...existing, ...values }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserts.push(values);
          return [{ id: 'op-new', ...values }];
        },
      }),
    }),
  };
  return { tx: tx as unknown as DrizzleDb, updates, inserts };
}

const command = (payload: Record<string, unknown>) => ({
  tenantId: 't1',
  idempotencyKey: 'k1',
  commandType: 'X',
  payload,
});

describe('hashPayload', () => {
  it('ignores key order at every level, keeps array order, and drops undefined members', () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashPayload({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
    expect(hashPayload({ a: 1, skip: undefined })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({ list: [1, 2] })).not.toBe(hashPayload({ list: [2, 1] }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload({ a: null })).not.toBe(hashPayload({ a: 'null' }));
  });
});

describe('acceptCommand', () => {
  it('inserts a PENDING operation with its payload hash for an unseen key', async () => {
    const { tx, inserts } = fakeCommandTx(undefined);

    const result = await acceptCommand(tx, command({ amount: 10 }));

    expect(result.isNew).toBe(true);
    expect(inserts).toEqual([
      {
        tenantId: 't1',
        idempotencyKey: 'k1',
        commandType: 'X',
        status: 'PENDING',
        payload: { amount: 10 },
        payloadHash: hashPayload({ amount: 10 }),
      },
    ]);
  });

  it('a rebuilt-but-identical payload is a replay; a different payload is a conflict', async () => {
    const existing = { id: 'op-1', payloadHash: hashPayload({ amount: 10, member: 'm1' }) };
    const { tx } = fakeCommandTx(existing);

    const replay = await acceptCommand(tx, command({ member: 'm1', amount: 10 }));
    expect(replay).toEqual({ operation: existing, isNew: false });

    await expect(acceptCommand(tx, command({ member: 'm1', amount: 11 }))).rejects.toThrow(
      OperationPayloadConflictError,
    );
    await expect(acceptCommand(tx, command({ member: 'm1', amount: 11 }))).rejects.toThrow(
      'Idempotency key "k1" was already used with a different payload',
    );
  });

  it('a row accepted before payload hashes existed adopts the hash instead of conflicting', async () => {
    const { tx, updates } = fakeCommandTx({ id: 'op-legacy', payloadHash: null });

    const result = await acceptCommand(tx, command({ amount: 10 }));

    expect(result.isNew).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].payloadHash).toBe(hashPayload({ amount: 10 }));
  });
});
