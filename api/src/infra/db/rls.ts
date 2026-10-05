import { sql } from 'drizzle-orm';
import type { DrizzleDb } from './postgres.provider.js';

export interface RlsContext {
  userId?: string;
  tenantId?: string;
  role?: string;
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
