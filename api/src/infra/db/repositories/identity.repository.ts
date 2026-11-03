import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { organizations } from '../schema/organizations.schema.js';

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findEndUserBySuiAddress(suiAddress: string) {
    return this.db.query.endUsers.findFirst({ where: eq(endUsers.suiAddress, suiAddress) });
  }

  async findEndUserById(endUserId: string) {
    return this.db.query.endUsers.findFirst({ where: eq(endUsers.id, endUserId) });
  }

  /** Returns undefined when a concurrent request already created this address's end user. */
  async createEndUser(params: { suiAddress: string }) {
    const [created] = await this.db
      .insert(endUsers)
      .values(params)
      .onConflictDoNothing({ target: endUsers.suiAddress })
      .returning();
    return created;
  }

  async organizationExists(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row !== undefined;
  }

  async findEnrollment(organizationId: string, endUserId: string) {
    return this.db.query.organizationEndUsers.findFirst({
      where: and(
        eq(organizationEndUsers.organizationId, organizationId),
        eq(organizationEndUsers.endUserId, endUserId),
      ),
    });
  }

  /** Returns undefined when a concurrent request already enrolled this end user in this organization. */
  async enroll(params: { organizationId: string; endUserId: string; externalMemberId?: string }) {
    const [created] = await this.db
      .insert(organizationEndUsers)
      .values(params)
      .onConflictDoNothing({ target: [organizationEndUsers.organizationId, organizationEndUsers.endUserId] })
      .returning();
    return created;
  }
}
