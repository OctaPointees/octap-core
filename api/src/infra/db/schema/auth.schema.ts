import { sql } from 'drizzle-orm';
import { jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

// Keep schema loading independent of ESM-only runtime packages for drizzle-kit.
export const systemUserRoleEnum = pgEnum('system_user_role', ['SYSTEM_USER', 'SYSTEM_ADMIN']);
export const membershipRoleEnum = pgEnum('membership_role', [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'STAFF',
  'VIEWER',
  'BUSINESS_DEVELOPER',
]);
export const invitationStatusEnum = pgEnum('invitation_status', ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export const changeRequestStatusEnum = pgEnum('change_request_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);
export const changeRequestTypeEnum = pgEnum('change_request_type', [
  'CREATE_ORGANIZATION',
  'UPDATE_PROFILE',
  'TRANSFER_OWNERSHIP',
  'DEACTIVATE',
]);

/**
 * SYSTEM USER: Internal console users, merchant operators, administrators.
 */
export const systemUsers = pgTable(
  'system_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    googleSubject: text('google_subject').unique(),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    avatarUrl: text('avatar_url'),
    systemRole: systemUserRoleEnum('system_role').default('SYSTEM_USER').notNull(),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('users_can_view_own_profile', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.id} = ${authUid}`,
    }),
  ],
);

/**
 * INVITATION: Invitations sent to invite System Users into Organizations.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invitedById: uuid('invited_by_id')
      .notNull()
      .references(() => systemUsers.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: membershipRoleEnum('role').default('STAFF').notNull(),
    token: text('token').notNull().unique(),
    status: invitationStatusEnum('status').default('PENDING').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('invitation_org_email_pending_idx')
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'PENDING'`),
  ],
).enableRLS();

/**
 * ORGANIZATION MEMBERSHIP: Associates System Users with Organizations with specific roles.
 */
export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    systemUserId: uuid('system_user_id')
      .notNull()
      .references(() => systemUsers.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').default('STAFF').notNull(),
    status: text('status').default('ACTIVE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('membership_org_user_idx').on(t.organizationId, t.systemUserId),
    pgPolicy('members_can_view_their_org_memberships', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.systemUserId} = ${authUid}`,
    }),
  ],
);

/**
 * ORGANIZATION CHANGE REQUEST: Audited proposals / workflow requests to create or modify an Organization.
 */
export const organizationChangeRequests = pgTable('organization_change_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  requestedById: uuid('requested_by_id')
    .notNull()
    .references(() => systemUsers.id, { onDelete: 'cascade' }),
  reviewedById: uuid('reviewed_by_id').references(() => systemUsers.id, { onDelete: 'set null' }),
  requestType: changeRequestTypeEnum('request_type').notNull(),
  status: changeRequestStatusEnum('status').default('PENDING').notNull(),
  payload: jsonb('payload').default({}).notNull(),
  reason: text('reason'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();
