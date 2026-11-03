import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../postgres.provider.js';
import { organizations } from '../schema/organizations.schema.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { withRls } from '../rls.js';

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
    if (org?.status !== 'ACTIVE') throw new ForbiddenException('Organization is not active');
    const [member] = await tx
      .select({ status: organizationEndUsers.status, globalStatus: endUsers.status })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
      .where(and(eq(organizationEndUsers.id, memberId), eq(organizationEndUsers.organizationId, organizationId)))
      .for('share');
    if (!member) throw new NotFoundException('Member not found in this organization');
    if (member.status !== 'ACTIVE' || member.globalStatus !== 'ACTIVE')
      throw new ForbiddenException('Member is not active');
    return withRls(tx, { tenantId: organizationId, role: 'authenticated' }, action);
  });
}
