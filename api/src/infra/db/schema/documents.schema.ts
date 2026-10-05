import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, pgPolicy } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid } from 'drizzle-orm/supabase';

/**
 * Example demonstrating Supabase Row Level Security (RLS) policies declared natively in Drizzle.
 * - 'to: authenticatedRole': restricts access to authenticated users.
 * - 'using: sql`${t.userId} = ${authUid}`': asserts that user_id matches auth.uid().
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    content: text('content'),
  },
  (t) => [
    pgPolicy('user_can_access_own_docs', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.userId} = ${authUid}`,
    }),
  ],
);
