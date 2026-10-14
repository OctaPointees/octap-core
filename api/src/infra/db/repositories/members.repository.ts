import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';

@Injectable()
export class MembersRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findOrCreateByPhone(organizationId: string, phoneNumber: string, displayName?: string) {
    return this.db.transaction(async (tx) => {
      let endUser = await tx.query.endUsers.findFirst({ where: eq(endUsers.phoneNumber, phoneNumber) });
      if (!endUser) {
        const [created] = await tx.insert(endUsers).values({ phoneNumber, displayName }).returning();
        endUser = created;
      }

      let membership = await tx.query.organizationEndUsers.findFirst({
        where: and(eq(organizationEndUsers.organizationId, organizationId), eq(organizationEndUsers.endUserId, endUser.id)),
      });
      let isNewMember = false;
      if (!membership) {
        const [created] = await tx
          .insert(organizationEndUsers)
          .values({ organizationId, endUserId: endUser.id })
          .returning();
        membership = created;
        isNewMember = true;
      }

      return { organizationEndUserId: membership.id, isNewMember };
    });
  }
}
