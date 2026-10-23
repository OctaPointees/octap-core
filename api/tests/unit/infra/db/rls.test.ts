import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withRls } from '../../../../src/infra/db/rls.js';
import type { DrizzleDb } from '../../../../src/infra/db/postgres.provider.js';

const dialect = new PgDialect();

/** Runs `withRls` against a fake db and returns the SQL it issued before handing over the tx. */
async function statementsFor(context: Parameters<typeof withRls>[1]) {
  const executed: SQL[] = [];
  const tx = { execute: vi.fn(async (query: SQL) => executed.push(query)) };
  const db = { transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) } as unknown as DrizzleDb;
  const result = await withRls(db, context, async (t) => {
    expect(t).toBe(tx);
    return 'callback-result';
  });
  return { result, statements: executed.map((q) => dialect.sqlToQuery(q)) };
}

describe('withRls', () => {
  it('sets an explicit role and the tenant GUCs, then returns the callback result', async () => {
    const { result, statements } = await statementsFor({ tenantId: 'org-1', role: 'authenticated' });

    expect(result).toBe('callback-result');
    expect(statements.map((s) => s.sql)).toEqual([
      'SET LOCAL ROLE authenticated',
      "SELECT set_config('app.current_tenant_id', $1, true)",
      "SELECT set_config('request.jwt.claims', $1, true)",
    ]);
    expect(statements[1].params).toEqual(['org-1']);
    expect(JSON.parse(statements[2].params[0] as string)).toEqual({ sub: null, tenant_id: 'org-1' });
  });

  it('defaults to the authenticated role when only identity claims are given', async () => {
    const { statements } = await statementsFor({ userId: 'user-1', tenantId: 'org-1' });

    expect(statements.map((s) => s.sql)).toEqual([
      'SET LOCAL ROLE authenticated',
      "SELECT set_config('request.jwt.claim.sub', $1, true)",
      "SELECT set_config('app.current_tenant_id', $1, true)",
      "SELECT set_config('request.jwt.claims', $1, true)",
    ]);
    expect(JSON.parse(statements[3].params[0] as string)).toEqual({ sub: 'user-1', tenant_id: 'org-1' });
  });

  it('a user-only context sets the subject claim but no tenant', async () => {
    const { statements } = await statementsFor({ userId: 'user-1' });
    expect(statements.map((s) => s.sql)).toEqual(['SET LOCAL ROLE authenticated', "SELECT set_config('request.jwt.claim.sub', $1, true)"]);
  });

  it('an empty context changes nothing', async () => {
    expect((await statementsFor({})).statements).toEqual([]);
  });
});
