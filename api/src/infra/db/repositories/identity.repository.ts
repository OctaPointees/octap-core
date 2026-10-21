import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findEndUserBySuiAddress(suiAddress: string) {
    return this.db.query.endUsers.findFirst({ where: eq(endUsers.suiAddress, suiAddress) });
  }

  async findEndUserById(endUserId: string) {
    return this.db.query.endUsers.findFirst({ where: eq(endUsers.id, endUserId) });
  }

  async createEndUser(params: { suiAddress: string }) {
    const [created] = await this.db.insert(endUsers).values(params).returning();
    return created;
  }

  async findEnrollment(organizationId: string, endUserId: string) {
    return this.db.query.organizationEndUsers.findFirst({
      where: and(eq(organizationEndUsers.organizationId, organizationId), eq(organizationEndUsers.endUserId, endUserId)),
    });
  }

  async enroll(params: { organizationId: string; endUserId: string; externalMemberId?: string }) {
    const [created] = await this.db.insert(organizationEndUsers).values(params).returning();
    return created;
  }
}
