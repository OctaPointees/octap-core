import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { organizations } from '../schema/organizations.schema.js';

/** Eligibility changed after the service's early check, so nothing was written. */
export class EnrollmentRefusedError extends Error {
  constructor(readonly reason: 'ORGANIZATION_NOT_ACTIVE' | 'CUSTOMER_NOT_ACTIVE') {
    super(reason);
    this.name = 'EnrollmentRefusedError';
  }
}

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findEndUserBySuiAddress(suiAddress: string) {
    return this.db.query.endUsers.findFirst({ where: eq(endUsers.suiAddress, suiAddress) });
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

  async findOrganizationStatus(organizationId: string) {
    const [row] = await this.db
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row?.status;
  }

  async findEnrollment(organizationId: string, endUserId: string) {
    return this.db.query.organizationEndUsers.findFirst({
      where: and(
        eq(organizationEndUsers.organizationId, organizationId),
        eq(organizationEndUsers.endUserId, endUserId),
      ),
    });
  }

  /**
   * Returns undefined when a concurrent request already enrolled this end user in this organization.
   * The share locks serialize against a suspension or block: whichever commits first, the other sees
   * it, so a membership can never be created after one of them has committed.
   */
  async enroll(params: { organizationId: string; endUserId: string }) {
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, params.organizationId))
        .for('share');
      if (organization?.status !== 'ACTIVE') throw new EnrollmentRefusedError('ORGANIZATION_NOT_ACTIVE');

      const [endUser] = await tx
        .select({ status: endUsers.status })
        .from(endUsers)
        .where(eq(endUsers.id, params.endUserId))
        .for('share');
      if (endUser?.status !== 'ACTIVE') throw new EnrollmentRefusedError('CUSTOMER_NOT_ACTIVE');

      const [created] = await tx
        .insert(organizationEndUsers)
        .values(params)
        .onConflictDoNothing({ target: [organizationEndUsers.organizationId, organizationEndUsers.endUserId] })
        .returning();
      return created;
    });
  }
}
