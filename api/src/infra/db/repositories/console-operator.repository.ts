import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { VerifiedGoogleIdentity } from '#infra/clients/google/google-identity.client.js';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { systemUsers } from '../schema/auth.schema.js';

export interface ConsoleOperatorInput {
  action: 'bootstrap-admin' | 'link';
  userId?: string;
}
export class ConsoleOperatorError extends Error {}
type User = typeof systemUsers.$inferSelect;
const snapshot = (user: User) => ({
  id: user.id,
  email: user.email,
  systemRole: user.systemRole,
  googleSubject: user.googleSubject,
});

/** Operator-only tooling: never exposed by a controller or called during sign-in. */
@Injectable()
export class ConsoleOperatorRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async execute(
    input: ConsoleOperatorInput,
    identity: VerifiedGoogleIdentity,
    audit: (change: { before: ReturnType<typeof snapshot> | null; after: ReturnType<typeof snapshot> }) => void,
  ) {
    return this.db.transaction(
      async (tx) => {
        if (input.action === 'bootstrap-admin') {
          const admin = await tx.query.systemUsers.findFirst({ where: eq(systemUsers.systemRole, 'SYSTEM_ADMIN') });
          if (admin)
            throw new ConsoleOperatorError(
              'A System Admin already exists; bootstrap is only for the first administrator',
            );
        } else if (!input.userId) throw new ConsoleOperatorError('Link requires an explicit system user ID');
        const existing = input.userId
          ? await tx.query.systemUsers.findFirst({ where: eq(systemUsers.id, input.userId) })
          : await tx.query.systemUsers.findFirst({ where: eq(systemUsers.googleSubject, identity.subject) });
        if (input.userId && !existing) throw new ConsoleOperatorError('System user not found');
        if (existing && existing.email.toLowerCase() !== identity.email)
          throw new ConsoleOperatorError('Verified Google email does not match the selected system user');
        if (existing?.googleSubject && existing.googleSubject !== identity.subject)
          throw new ConsoleOperatorError('This system user is already bound to a different Google identity');
        const subjectOwner = await tx.query.systemUsers.findFirst({
          where: eq(systemUsers.googleSubject, identity.subject),
        });
        if (subjectOwner && subjectOwner.id !== existing?.id)
          throw new ConsoleOperatorError('This Google identity is already bound to another system user');
        if (!existing) {
          const collision = await tx.query.systemUsers.findFirst({ where: eq(systemUsers.email, identity.email) });
          if (collision)
            throw new ConsoleOperatorError('An email account already exists; select its --user-id explicitly');
        }
        const role = input.action === 'bootstrap-admin' ? 'SYSTEM_ADMIN' : existing!.systemRole;
        const [after] = existing
          ? await tx
              .update(systemUsers)
              .set({ googleSubject: identity.subject, systemRole: role, updatedAt: new Date() })
              .where(eq(systemUsers.id, existing.id))
              .returning()
          : await tx
              .insert(systemUsers)
              .values({
                email: identity.email,
                fullName: identity.fullName,
                avatarUrl: identity.avatarUrl,
                googleSubject: identity.subject,
                systemRole: role,
              })
              .returning();
        const change = { before: existing ? snapshot(existing) : null, after: snapshot(after) };
        // A failed audit write aborts the database transaction. CLI records commit outcome separately.
        audit(change);
        return change;
      },
      { isolationLevel: 'serializable' },
    );
  }
}
