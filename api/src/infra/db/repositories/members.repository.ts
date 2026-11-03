import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, or } from 'drizzle-orm';
import type { MemberDirectoryQuery, MemberProfilePatch } from '@octap/contracts';
import { ConsoleNotFoundError, ConsoleOrganizationsRepository } from './console-organizations.repository.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';

const fields = {
  id: organizationEndUsers.id,
  endUserId: organizationEndUsers.endUserId,
  displayName: endUsers.displayName,
  email: endUsers.email,
  phoneNumber: endUsers.phoneNumber,
  tier: organizationEndUsers.tier,
  status: organizationEndUsers.status,
  externalMemberId: organizationEndUsers.externalMemberId,
  metadata: organizationEndUsers.metadata,
  joinedAt: organizationEndUsers.joinedAt,
};
@Injectable()
export class MembersRepository {
  constructor(private readonly access: ConsoleOrganizationsRepository) {}
  list(userId: string, organizationId: string, query: MemberDirectoryQuery) {
    return this.access.withAccess(userId, organizationId, false, async (tx) => {
      const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const rows = await tx
        .select(fields)
        .from(organizationEndUsers)
        .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
        .where(
          and(
            eq(organizationEndUsers.organizationId, organizationId),
            query.cursor ? gt(organizationEndUsers.id, query.cursor) : undefined,
            query.status ? eq(organizationEndUsers.status, query.status) : undefined,
            query.tier ? eq(organizationEndUsers.tier, query.tier) : undefined,
            query.externalMemberId ? eq(organizationEndUsers.externalMemberId, query.externalMemberId) : undefined,
            pattern
              ? or(
                  ilike(endUsers.displayName, pattern),
                  ilike(endUsers.email, pattern),
                  ilike(endUsers.phoneNumber, pattern),
                  ilike(organizationEndUsers.externalMemberId, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(asc(organizationEndUsers.id))
        .limit((query.limit ?? 25) + 1);
      const more = rows.length > (query.limit ?? 25);
      if (more) rows.pop();
      return {
        items: rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() })),
        nextCursor: more ? rows.at(-1)!.id : null,
      };
    });
  }
  detail(userId: string, organizationId: string, memberId: string) {
    return this.access.withAccess(userId, organizationId, false, async (tx) => {
      const [row] = await tx
        .select(fields)
        .from(organizationEndUsers)
        .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
        .where(and(eq(organizationEndUsers.organizationId, organizationId), eq(organizationEndUsers.id, memberId)));
      if (!row) throw new ConsoleNotFoundError();
      return { ...row, joinedAt: row.joinedAt.toISOString() };
    });
  }
  patch(userId: string, organizationId: string, memberId: string, input: MemberProfilePatch) {
    return this.access.withAccess(userId, organizationId, true, async (tx) => {
      const [row] = await tx
        .update(organizationEndUsers)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(organizationEndUsers.organizationId, organizationId), eq(organizationEndUsers.id, memberId)))
        .returning({ id: organizationEndUsers.id });
      if (!row) throw new ConsoleNotFoundError();
      return { updated: true };
    });
  }
}
