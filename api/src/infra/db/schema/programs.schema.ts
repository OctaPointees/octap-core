import { sql } from 'drizzle-orm';
import { bigint, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

/**
 * PROGRAM: one organization's on-chain loyalty program. Created once by `domain/programs`'
 * provisioning flow (`scripts/provision-program.mjs`) — a new policy version is a new on-chain
 * object and a new `policyVersionId`/`earnBps`/`expiryMs`, not a mutation of this row.
 *
 * The row is inserted as a `PROVISIONING` reservation *before* any chain call, so the unique
 * index on `organization_id` is what serializes concurrent provisioning — the on-chain ids are
 * null until the chain calls succeed and the row flips to `ACTIVE`.
 */
export const programs = pgTable(
  'programs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    status: text('status').default('PROVISIONING').notNull(),
    programControlId: text('program_control_id'),
    adminCapId: text('admin_cap_id'),
    policyVersionId: text('policy_version_id'),
    issuerCapId: text('issuer_cap_id'),
    policyVersion: integer('policy_version').notNull(),
    earnBps: integer('earn_bps').notNull(),
    expiryMs: bigint('expiry_ms', { mode: 'number' }).notNull(),
    /** Operation and budget shards always share one count and one index (see `budget_shard.move`). */
    shardCount: integer('shard_count').notNull(),
    /** Issuance budget in credits at provisioning time, split across `budgetShardIds`. */
    totalBudget: bigint('total_budget', { mode: 'number' }).notNull(),
    /** `OperationShard` object ids in shard-index order; null until `ACTIVE`, like the ids above. */
    operationShardIds: text('operation_shard_ids').array(),
    /** `BudgetShard` object ids in shard-index order; null until `ACTIVE`. */
    budgetShardIds: text('budget_shard_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('programs_organization_id_idx').on(t.organizationId),
    pgPolicy('tenant_can_view_own_program', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
