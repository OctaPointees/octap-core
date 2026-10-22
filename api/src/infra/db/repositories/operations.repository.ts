import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { operations } from '../schema/operations.schema.js';

/** Thrown by `acceptCommand` when an idempotency key is reused with a different payload. */
export class OperationPayloadConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
    this.name = 'OperationPayloadConflictError';
  }
}

/** JSON with object keys sorted at every level, so the same logical payload always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Durable-command acceptance, usable by any feature's repository inside its own transaction —
 * not a repository method, because it must run on the caller's `tx` (same transaction as the
 * business write it's paired with), never open its own. Today's only caller is
 * `CreditsRepository.recordEarnTransaction`; a future feature (e.g. OCT-55's redeem) reuses this
 * instead of hand-rolling its own `operations` insert.
 *
 * Same idempotency key + same payload -> returns the existing operation (`isNew: false`).
 * Same idempotency key + a *different* payload -> throws `OperationPayloadConflictError`.
 * Unseen idempotency key -> inserts a new PENDING operation (`isNew: true`).
 */
export async function acceptCommand(
  tx: DrizzleDb,
  params: { tenantId: string; idempotencyKey: string; commandType: string; payload: Record<string, unknown> },
): Promise<{ operation: typeof operations.$inferSelect; isNew: boolean }> {
  const payloadHash = hashPayload(params.payload);
  const existing = await tx.query.operations.findFirst({
    where: and(eq(operations.tenantId, params.tenantId), eq(operations.idempotencyKey, params.idempotencyKey)),
  });

  if (existing) {
    if (existing.payloadHash === null) {
      // Accepted before payload hashes existed: nothing to compare against, so adopt this one.
      const [adopted] = await tx
        .update(operations)
        .set({ payloadHash, updatedAt: new Date() })
        .where(eq(operations.id, existing.id))
        .returning();
      return { operation: adopted, isNew: false };
    }
    if (existing.payloadHash !== payloadHash) {
      throw new OperationPayloadConflictError(params.idempotencyKey);
    }
    return { operation: existing, isNew: false };
  }

  const [created] = await tx
    .insert(operations)
    .values({
      tenantId: params.tenantId,
      idempotencyKey: params.idempotencyKey,
      commandType: params.commandType,
      status: 'PENDING',
      payload: params.payload,
      payloadHash,
    })
    .returning();
  return { operation: created, isNew: true };
}

/**
 * Minimal slice of the "operations" durable-command concern needed to dispatch an already-
 * accepted command to Sui. `domain/operations` (dedup, outbox replay, UNKNOWN recovery) in
 * docs/roadmap.md is the full feature; this repository only claims/resolves rows that
 * `CreditsRepository` already enqueued inside the same transaction as their PG command write.
 */
@Injectable()
export class OperationsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Claims up to `limit` PENDING rows of the given command types by flipping them to PROCESSING
   * one at a time with a conditional update, so two worker instances racing on the same row only
   * ever have one succeed. (A single `UPDATE ... RETURNING` with `SKIP LOCKED` would claim a
   * batch in one round-trip instead of N+1; fine for today's single-worker demo, worth revisiting
   * before running more than one worker instance.)
   */
  async claimNextPending(commandTypes: string[], limit = 5) {
    const candidates = await this.db.query.operations.findMany({
      where: and(eq(operations.status, 'PENDING'), inArray(operations.commandType, commandTypes)),
      orderBy: [asc(operations.createdAt)],
      limit,
    });

    const claimed: (typeof operations.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const [row] = await this.db
        .update(operations)
        .set({ status: 'PROCESSING', updatedAt: new Date() })
        .where(and(eq(operations.id, candidate.id), eq(operations.status, 'PENDING')))
        .returning();
      if (row) {
        claimed.push(row);
      }
    }
    return claimed;
  }

  async markSubmitted(id: string, suiTxDigest: string) {
    await this.db
      .update(operations)
      .set({ status: 'SUBMITTED', suiTxDigest, updatedAt: new Date() })
      .where(eq(operations.id, id));
  }

  async markFailed(id: string, errorMessage: string) {
    await this.db
      .update(operations)
      .set({ status: 'FAILED', errorMessage, updatedAt: new Date() })
      .where(eq(operations.id, id));
  }

  /**
   * Flips PROCESSING rows untouched for longer than `olderThanMs` to UNKNOWN: a worker claimed
   * them, then died before calling `markSubmitted`/`markFailed`, so whether the chain effect
   * happened was never learned. Never auto-retried from here — blindly resubmitting could create
   * a second business effect, which is exactly what durable commands exist to prevent. Meant to
   * run once at worker startup, before the first poll, so a crashed previous instance's rows
   * are surfaced (not silently stuck forever) rather than reclaimed.
   *
   * Scoped to `commandTypes` like `claimNextPending`: each worker only sweeps its own commands,
   * with its own threshold, never another worker's still-running ones.
   */
  async recoverStaleProcessing(
    commandTypes: string[],
    olderThanMs: number,
  ): Promise<(typeof operations.$inferSelect)[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this.db
      .update(operations)
      .set({ status: 'UNKNOWN', updatedAt: new Date() })
      .where(
        and(
          eq(operations.status, 'PROCESSING'),
          inArray(operations.commandType, commandTypes),
          lt(operations.updatedAt, cutoff),
        ),
      )
      .returning();
  }
}
