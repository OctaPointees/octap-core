import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../postgres.provider.js';
import { organizations } from '../schema/organizations.schema.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { withRls } from '../rls.js';

export class MemberEligibilityError extends Error {
  constructor(
    readonly kind: 'FORBIDDEN' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

/** Locks eligibility before accepting new work; settlement of already accepted work stays allowed. */
export function withActiveMember<T>(
  db: DrizzleDb,
  organizationId: string,
  memberId: string,
  action: Parameters<typeof withRls<T>>[2],
) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('share');
    if (org?.status !== 'ACTIVE') throw new MemberEligibilityError('FORBIDDEN', 'Organization is not active');
    const [member] = await tx
      .select({ status: organizationEndUsers.status, globalStatus: endUsers.status })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
      .where(and(eq(organizationEndUsers.id, memberId), eq(organizationEndUsers.organizationId, organizationId)))
      .for('share');
    if (!member) throw new MemberEligibilityError('NOT_FOUND', 'Member not found in this organization');
    if (member.status !== 'ACTIVE' || member.globalStatus !== 'ACTIVE')
      throw new MemberEligibilityError('FORBIDDEN', 'Member is not active');
    return withRls(tx, { tenantId: organizationId, role: 'authenticated' }, action);
  });
}
