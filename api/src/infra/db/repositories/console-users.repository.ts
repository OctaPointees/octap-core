import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { ConsoleIdentity } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { organizationMemberships, systemUsers } from '../schema/auth.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { withRls } from '../rls.js';

export class GoogleAccountLinkRequiredError extends Error {}

@Injectable()
export class ConsoleUsersRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async resolveGoogleUser(identity: { subject: string; email: string; fullName: string; avatarUrl: string | null }) {
    // Identity bootstrap uses the trusted server connection. Never auto-link by email:
    // legacy platform administrators must be linked by a controlled administrator operation.
    const existing = await this.db.query.systemUsers.findFirst({
      where: eq(systemUsers.googleSubject, identity.subject),
    });
    if (existing) return existing;
    const [created] = await this.db
      .insert(systemUsers)
      .values({
        googleSubject: identity.subject,
        email: identity.email,
        fullName: identity.fullName,
        avatarUrl: identity.avatarUrl,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const concurrent = await this.db.query.systemUsers.findFirst({
      where: eq(systemUsers.googleSubject, identity.subject),
    });
    if (concurrent) return concurrent;
    throw new GoogleAccountLinkRequiredError();
  }

  async memberships(systemUserId: string): Promise<ConsoleIdentity['organizations']> {
    return withRls(this.db, { userId: systemUserId }, async (tx) => {
      const rows = await tx
        .select({
          organizationId: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          role: organizationMemberships.role,
        })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
        .where(
          and(
            eq(organizationMemberships.systemUserId, systemUserId),
            eq(organizationMemberships.status, 'ACTIVE'),
            eq(organizations.status, 'ACTIVE'),
            inArray(organizationMemberships.role, ['OWNER', 'BUSINESS_DEVELOPER']),
          ),
        )
        .orderBy(organizations.name, organizations.id);
      return rows.map((row) => ({
        organizationId: row.organizationId,
        name: row.name,
        slug: row.slug,
        persona: row.role === 'OWNER' ? 'BUSINESS_OWNER' : 'BUSINESS_DEVELOPER',
      }));
    });
  }
}
