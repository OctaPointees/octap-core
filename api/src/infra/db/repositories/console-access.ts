import { eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../postgres.provider.js';
import { systemUsers } from '../schema/auth.schema.js';

export class ConsoleAccessError extends Error {}
export class ConsoleConflictError extends Error {}
export class ConsoleGoneError extends Error {}
export class ConsoleNotFoundError extends Error {}
export class ConsoleValidationError extends Error {}
export const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export async function requireSystemAdmin(tx: DrizzleDb, actor: string) {
  const [user] = await tx
    .select({ role: systemUsers.systemRole })
    .from(systemUsers)
    .where(eq(systemUsers.id, actor))
    .for('share');
  if (user?.role !== 'SYSTEM_ADMIN') throw new ConsoleAccessError('System Admin role required');
}

/** Batched lookup of the actual recipient, distinct from an admin submitting on their behalf. */
export async function withInitialOwners<T extends { requestedById: string; payload: unknown; requestType?: string }>(
  tx: DrizzleDb,
  rows: T[],
) {
  const ownerId = (row: T) => {
    if (row.requestType && row.requestType !== 'CREATE_ORGANIZATION') return null;
    const saved = (row.payload as { initialOwnerId?: unknown } | null)?.initialOwnerId;
    return typeof saved === 'string' && UUID_PATTERN.test(saved) ? saved : row.requestedById;
  };
  const ids = rows.map(ownerId).filter((id): id is string => !!id);
  const users = ids.length
    ? await tx
        .select({ id: systemUsers.id, fullName: systemUsers.fullName, email: systemUsers.email })
        .from(systemUsers)
        .where(inArray(systemUsers.id, ids))
    : [];
  return rows.map((row) => {
    const user = users.find((user) => user.id === ownerId(row));
    return { ...row, initialOwnerName: user?.fullName ?? null, initialOwnerEmail: user?.email ?? null };
  });
}
