import { sql } from 'drizzle-orm';
import type { DrizzleDb } from './postgres.provider.js';

export interface RlsContext {
  userId?: string;
  tenantId?: string;
  role?: string;
}

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Runs `work` as the RLS-bound `authenticated` role with `app.current_tenant_id = organizationId`,
 * so Postgres itself hides every other organization's rows on tables with a tenant policy.
 *
 * Unlike `withRls`, it may run inside a caller's transaction (a savepoint there) and leaves that
 * transaction as it found it. `SET LOCAL` outlives a released savepoint, so without restoring, the
 * rest of the caller's transaction would keep the tenant role, and could no longer see or lock rows
 * only the connection's own role may (`organizations`, for one). A savepoint that rolls back
 * reverts the settings by itself.
 *
 * Checks on tables the tenant role cannot read (an organization's status, a member's global user)
 * belong before this call, on the caller's connection.
 */
export async function withTenant<T>(db: DrizzleDb, organizationId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [previous] = await tx.execute<{ role: string; tenant: string | null }>(
      sql`select current_setting('role') as role, current_setting('app.current_tenant_id', true) as tenant`,
    );
    await tx.execute(
      sql`select set_config('role', 'authenticated', true), set_config('app.current_tenant_id', ${organizationId}, true)`,
    );
    const result = await work(tx);
    await tx.execute(
      sql`select set_config('role', ${previous.role}, true), set_config('app.current_tenant_id', ${previous.tenant ?? ''}, true)`,
    );
    return result;
  });
}

/**
 * Inside a `withTenant` block, runs `work` as the connection's own role, then switches back. Only for
 * checks on tables the tenant role cannot read or lock (an organization's status, a member's global
 * user) that must happen at that point of the block, after locks the block already holds. Moving
 * such a check before the block would change both the lock order and the business rule.
 */
export async function asOwnRole<T>(tx: DrizzleDb, work: () => Promise<T>): Promise<T> {
  const [previous] = await tx.execute<{ role: string }>(sql`select current_setting('role') as role`);
  await tx.execute(sql`select set_config('role', 'none', true)`);
  const result = await work();
  await tx.execute(sql`select set_config('role', ${previous.role}, true)`);
  return result;
}

/**
 * Executes a callback within a database transaction configured with session variables
 * for Supabase Row Level Security (RLS) enforcement.
 */
export async function withRls<T>(
  db: DrizzleDb,
  context: RlsContext,
  callback: (tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (context.role) {
      await tx.execute(sql`SET LOCAL ROLE ${sql.raw(context.role)}`);
    } else if (context.userId || context.tenantId) {
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
    }

    if (context.userId) {
      await tx.execute(sql`SELECT set_config('request.jwt.claim.sub', ${context.userId}, true)`);
    }

    if (context.tenantId) {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${context.tenantId}, true)`);
      const claims = JSON.stringify({ sub: context.userId ?? null, tenant_id: context.tenantId });
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    }

    return callback(tx);
  });
}
