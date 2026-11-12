import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, desc } from 'drizzle-orm';
import type { ConsoleIdentity, OrganizationApplicationInput, OrganizationProfileInput } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import {
  invitations,
  organizationChangeRequests,
  organizationMemberships,
  systemUsers,
} from '../schema/auth.schema.js';
import { organizations, apiCredentials, organizationIdentityDetails } from '../schema/organizations.schema.js';
import { OrganizationIdentityCipher } from '../organization-identity.cipher.js';

import {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleGoneError,
  ConsoleNotFoundError,
  ConsoleValidationError,
  requireSystemAdmin,
  withInitialOwners,
} from './console-access.js';
export {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleGoneError,
  ConsoleNotFoundError,
  ConsoleValidationError,
} from './console-access.js';
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const hashToken = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex')}`;
function requestedSlug(payload: unknown, fallback: string) {
  const saved =
    payload && typeof payload === 'object' ? (payload as { requestedSlug?: unknown }).requestedSlug : undefined;
  return typeof saved === 'string' && /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(saved) ? saved : fallback;
}
const applicationFields = {
  requestedById: organizationChangeRequests.requestedById,
  id: organizationChangeRequests.id,
  organizationId: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  payload: organizationChangeRequests.payload,
  status: organizationChangeRequests.status,
  reason: organizationChangeRequests.reason,
  createdAt: organizationChangeRequests.createdAt,
  applicantEmail: systemUsers.email,
  organizationType: organizations.organizationType,
  representativeName: organizations.representativeName,
  legalName: organizations.legalName,
  taxId: organizations.taxId,
  nationalIdLast4: organizationIdentityDetails.nationalIdLast4,
};

@Injectable()
export class ConsoleOrganizationsRepository {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly identityCipher: OrganizationIdentityCipher,
  ) {}

  /** Privileged workflows deliberately use the server connection, with actor checks inside each transaction. */
  private async member(tx: Tx, userId: string, organizationId: string, ownerOnly = false, mutating = true) {
    const lock = mutating ? 'update' : 'share';
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for(lock);
    const [membership] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.systemUserId, userId),
          eq(organizationMemberships.status, 'ACTIVE'),
          inArray(organizationMemberships.role, ownerOnly ? ['OWNER'] : ['OWNER', 'BUSINESS_DEVELOPER']),
        ),
      )
      .for(lock);
    if (org?.status !== 'ACTIVE' || !membership) throw new ConsoleAccessError();
    return { org, membership };
  }
  private admin = requireSystemAdmin;
  async apply(userId: string, input: OrganizationApplicationInput, adminActorId?: string) {
    return this.db.transaction(async (tx) => {
      if (adminActorId) {
        await this.admin(tx, adminActorId);
        const owner = await tx.query.systemUsers.findFirst({ where: eq(systemUsers.id, userId) });
        if (!owner?.googleSubject) throw new ConsoleValidationError('Initial Owner must first sign in with Google');
      }
      const { nationalId, ...publicDetails } = input;
      const [org] = await tx
        .insert(organizations)
        .values({ ...publicDetails, status: 'PENDING_APPROVAL' })
        .onConflictDoNothing()
        .returning();
      if (!org) throw new ConsoleConflictError('That organization slug is already reserved');
      if (nationalId) await this.saveNationalId(tx, org.id, nationalId);
      const [request] = await tx
        .insert(organizationChangeRequests)
        .values({
          organizationId: org.id,
          requestedById: adminActorId ?? userId,
          requestType: 'CREATE_ORGANIZATION',
          payload: { initialOwnerId: userId, requestedSlug: input.slug },
        })
        .returning();
      return request.id;
    });
  }
  async withAccess<T>(userId: string, organizationId: string, mutating: boolean, action: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, mutating, mutating);
      return action(tx);
    });
  }
  /**
   * Active Owner of an ACTIVE organization, holding the organization and membership rows FOR SHARE
   * until `action` commits: the Owner cannot be removed, nor the organization suspended, in between.
   * FOR SHARE, not FOR UPDATE, so `action` may lock a voucher afterwards. A claim locks the voucher
   * first and the organization FOR SHARE second; an update lock here would deadlock with it.
   */
  async withOwnerAccess<T>(userId: string, organizationId: string, action: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true, false);
      return action(tx);
    });
  }
  /**
   * Owner or Business Developer, locking the organization and membership rows for update, so `action`
   * commits only while the caller still has access (unlike `withAccess`, whose writes are Owner-only).
   * `action` gets the caller's role, for rules that differ between the two.
   */
  async withDeveloperAccess<T>(
    userId: string,
    organizationId: string,
    action: (tx: Tx, role: 'OWNER' | 'BUSINESS_DEVELOPER') => Promise<T>,
  ) {
    return this.db.transaction(async (tx) => {
      const { membership } = await this.member(tx, userId, organizationId, false, true);
      return action(tx, membership.role as 'OWNER' | 'BUSINESS_DEVELOPER');
    });
  }
  async applications(userId: string, platform = false) {
    return this.db.transaction(async (tx) => {
      if (platform) await this.admin(tx, userId);
      const rows = await tx
        .select(applicationFields)
        .from(organizationChangeRequests)
        .innerJoin(organizations, eq(organizations.id, organizationChangeRequests.organizationId))
        .innerJoin(systemUsers, eq(systemUsers.id, organizationChangeRequests.requestedById))
        .leftJoin(organizationIdentityDetails, eq(organizationIdentityDetails.organizationId, organizations.id))
        .where(
          and(
            eq(organizationChangeRequests.requestType, 'CREATE_ORGANIZATION'),
            platform ? undefined : eq(organizationChangeRequests.requestedById, userId),
          ),
        )
        .orderBy(desc(organizationChangeRequests.createdAt))
        .limit(100);
      const withOwners = await withInitialOwners(tx, rows);
      return withOwners.map(({ payload, ...row }) => ({
        ...row,
        slug: requestedSlug(payload, row.slug),
      }));
    });
  }
  async decide(userId: string, requestId: string, approve: boolean, reason?: string) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, userId);
      const [request] = await tx
        .select()
        .from(organizationChangeRequests)
        .where(
          and(
            eq(organizationChangeRequests.id, requestId),
            eq(organizationChangeRequests.requestType, 'CREATE_ORGANIZATION'),
          ),
        )
        .for('update');
      if (!request || !request.organizationId) throw new ConsoleNotFoundError();
      if (request.status !== 'PENDING') throw new ConsoleConflictError('This request has already been decided');
      const [org] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.organizationId))
        .for('update');
      if (org.status !== 'PENDING_APPROVAL')
        throw new ConsoleConflictError('Organization is no longer pending approval');
      await tx
        .update(organizations)
        .set({
          status: approve ? 'ACTIVE' : 'ARCHIVED',
          ...(!approve ? { slug: `rejected-${randomUUID()}` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id));
      if (approve) {
        const initialOwnerId = (request.payload as { initialOwnerId?: string }).initialOwnerId ?? request.requestedById;
        const owner = await tx.query.systemUsers.findFirst({ where: eq(systemUsers.id, initialOwnerId) });
        if (!owner?.googleSubject) throw new ConsoleConflictError('Initial Owner must have a verified Google account');
        await tx
          .insert(organizationMemberships)
          .values({ organizationId: org.id, systemUserId: initialOwnerId, role: 'OWNER' });
      }
      await tx
        .update(organizationChangeRequests)
        .set({
          status: approve ? 'APPROVED' : 'REJECTED',
          reviewedById: userId,
          payload: {
            ...(request.payload as Record<string, unknown>),
            requestedSlug: requestedSlug(request.payload, org.slug),
          },
          reviewedAt: new Date(),
          reason: reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(organizationChangeRequests.id, requestId));
      return { organizationId: org.id };
    });
  }
  async organization(userId: string, organizationId: string) {
    return this.db.transaction(async (tx) => {
      const { org, membership } = await this.member(tx, userId, organizationId, false, false);
      const masked =
        membership.role === 'OWNER'
          ? await tx
              .select({ last4: organizationIdentityDetails.nationalIdLast4 })
              .from(organizationIdentityDetails)
              .where(eq(organizationIdentityDetails.organizationId, organizationId))
          : [];
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        legalName: org.legalName,
        taxId: org.taxId,
        organizationType: org.organizationType,
        representativeName: org.representativeName,
        ...(membership.role === 'OWNER' ? { nationalIdLast4: masked[0]?.last4 ?? null } : {}),
        status: org.status,
        persona: membership.role === 'OWNER' ? ('BUSINESS_OWNER' as const) : ('BUSINESS_DEVELOPER' as const),
      };
    });
  }
  private async saveNationalId(tx: Tx, organizationId: string, nationalId: string) {
    const details = {
      nationalIdEncrypted: this.identityCipher.encrypt(nationalId, organizationId),
      nationalIdLast4: nationalId.slice(-4),
      updatedAt: new Date(),
    };
    await tx
      .insert(organizationIdentityDetails)
      .values({ organizationId, ...details })
      .onConflictDoUpdate({ target: organizationIdentityDetails.organizationId, set: details });
  }
  async profile(userId: string, organizationId: string, input: OrganizationProfileInput) {
    return this.db.transaction(async (tx) => {
      const { org } = await this.member(tx, userId, organizationId, true);
      const { nationalId, ...publicDetails } = input;
      const type = input.organizationType ?? org.organizationType;
      if (org.organizationType && input.organizationType && input.organizationType !== org.organizationType)
        throw new ConsoleValidationError('Organization type is already set');
      if (nationalId && type !== 'INDIVIDUAL_HOUSEHOLD')
        throw new ConsoleValidationError('CCCD belongs to an Individual / Household business organization');
      if (
        type === 'COMPANY' &&
        (!(input.legalName ?? org.legalName)?.trim() ||
          !/^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/.test(input.taxId ?? org.taxId ?? ''))
      )
        throw new ConsoleValidationError('Companies require a legal name and business registration / tax number');
      if (
        type === 'INDIVIDUAL_HOUSEHOLD' &&
        (input.representativeName ?? org.representativeName ?? '').trim().length < 2
      )
        throw new ConsoleValidationError('Representative name is required');
      if (nationalId) await this.saveNationalId(tx, organizationId, nationalId);
      await tx
        .update(organizations)
        .set({ ...publicDetails, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));
    });
  }
  async staff(userId: string, organizationId: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true, false);
      const rows = await tx
        .select({
          id: systemUsers.id,
          fullName: systemUsers.fullName,
          email: systemUsers.email,
          role: organizationMemberships.role,
          status: organizationMemberships.status,
        })
        .from(organizationMemberships)
        .innerJoin(systemUsers, eq(systemUsers.id, organizationMemberships.systemUserId))
        .where(
          and(
            eq(organizationMemberships.organizationId, organizationId),
            inArray(organizationMemberships.role, ['OWNER', 'BUSINESS_DEVELOPER']),
          ),
        )
        .orderBy(systemUsers.fullName)
        .limit(100);
      return rows.map(({ role, ...row }) => ({
        ...row,
        persona: role === 'OWNER' ? 'BUSINESS_OWNER' : 'BUSINESS_DEVELOPER',
      }));
    });
  }
  async staffAccess(userId: string, organizationId: string, targetId: string, status: 'ACTIVE' | 'SUSPENDED') {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true);
      const [target] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, organizationId),
            eq(organizationMemberships.systemUserId, targetId),
          ),
        )
        .for('update');
      if (!target) throw new ConsoleNotFoundError();
      if (target.role !== 'BUSINESS_DEVELOPER') throw new ConsoleAccessError();
      await tx
        .update(organizationMemberships)
        .set({ status, updatedAt: new Date() })
        .where(eq(organizationMemberships.id, target.id));
      // A pending invitation must not restore access after an Owner suspends it.
      if (status === 'SUSPENDED') {
        const [user] = await tx
          .select({ email: systemUsers.email })
          .from(systemUsers)
          .where(eq(systemUsers.id, targetId));
        await tx
          .update(invitations)
          .set({ status: 'REVOKED', updatedAt: new Date() })
          .where(
            and(
              eq(invitations.organizationId, organizationId),
              eq(invitations.email, user.email.toLowerCase()),
              eq(invitations.status, 'PENDING'),
            ),
          );
      }
    });
  }
  async bootstrapOwner(userId: string, organizationId: string, targetId: string) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, userId);
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for('update');
      if (!org) throw new ConsoleNotFoundError();
      if (org.status !== 'ACTIVE')
        throw new ConsoleConflictError('Only an active organization can receive its first Owner');
      const existing = await tx.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.role, 'OWNER'),
        ),
      });
      if (existing)
        throw new ConsoleConflictError('This organization already has an Owner; use the ownership workflow');
      const target = await tx.query.systemUsers.findFirst({ where: eq(systemUsers.id, targetId) });
      if (!target?.googleSubject) throw new ConsoleValidationError('The initial Owner must first sign in with Google');
      await tx
        .insert(organizationMemberships)
        .values({ organizationId, systemUserId: targetId, role: 'OWNER' })
        .onConflictDoUpdate({
          target: [organizationMemberships.organizationId, organizationMemberships.systemUserId],
          set: { role: 'OWNER', status: 'ACTIVE', updatedAt: new Date() },
        });
      await tx.insert(organizationChangeRequests).values({
        organizationId,
        requestedById: userId,
        reviewedById: userId,
        requestType: 'TRANSFER_OWNERSHIP',
        status: 'APPROVED',
        payload: { bootstrap: true, previousOwnerId: null, targetUserId: targetId },
        reason: 'System Admin assigned the first Owner of an active ownerless organization',
        reviewedAt: new Date(),
      });
    });
  }
  async credentials(userId: string, organizationId: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, false, false);
      return tx
        .select({
          id: apiCredentials.id,
          name: apiCredentials.name,
          keyPrefix: apiCredentials.keyPrefix,
          scopes: apiCredentials.scopes,
          status: apiCredentials.status,
          createdAt: apiCredentials.createdAt,
          lastUsedAt: apiCredentials.lastUsedAt,
        })
        .from(apiCredentials)
        .where(and(eq(apiCredentials.organizationId, organizationId), eq(apiCredentials.status, 'ACTIVE')))
        .orderBy(apiCredentials.createdAt)
        .limit(100);
    });
  }
  async invite(userId: string, organizationId: string, email: string, token: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true);
      await tx
        .update(invitations)
        .set({ status: 'EXPIRED', updatedAt: new Date() })
        .where(
          and(
            eq(invitations.organizationId, organizationId),
            eq(invitations.email, email),
            eq(invitations.status, 'PENDING'),
            lte(invitations.expiresAt, new Date()),
          ),
        );
      const [row] = await tx
        .insert(invitations)
        .values({
          organizationId,
          invitedById: userId,
          email,
          role: 'BUSINESS_DEVELOPER',
          token: hashToken(token),
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new ConsoleConflictError('An invitation for this email is already pending');
      return row;
    });
  }
  async invitationList(userId: string, organizationId: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true, false);
      return tx
        .select({
          id: invitations.id,
          email: invitations.email,
          status: invitations.status,
          expiresAt: invitations.expiresAt,
        })
        .from(invitations)
        .where(and(eq(invitations.organizationId, organizationId), eq(invitations.role, 'BUSINESS_DEVELOPER')))
        .orderBy(desc(invitations.createdAt))
        .limit(100);
    });
  }
  async revoke(userId: string, organizationId: string, invitationId: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, userId, organizationId, true);
      const [row] = await tx
        .update(invitations)
        .set({ status: 'REVOKED', updatedAt: new Date() })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.organizationId, organizationId),
            eq(invitations.status, 'PENDING'),
          ),
        )
        .returning();
      if (!row) throw new ConsoleConflictError('Invitation is no longer pending');
    });
  }
  async accept(identity: ConsoleIdentity, token: string) {
    return this.db.transaction(async (tx) => {
      // Find the tenant first so all invitation mutations lock org -> membership -> invitation.
      const candidate = await tx.query.invitations.findFirst({ where: eq(invitations.token, hashToken(token)) });
      if (!candidate) throw new ConsoleNotFoundError();
      await this.member(tx, candidate.invitedById, candidate.organizationId, true);
      const [row] = await tx.select().from(invitations).where(eq(invitations.id, candidate.id)).for('update');
      if (row.status !== 'PENDING' || row.expiresAt.getTime() <= Date.now()) throw new ConsoleGoneError();
      if (row.email !== identity.user.email.toLowerCase() || row.role !== 'BUSINESS_DEVELOPER')
        throw new ConsoleAccessError();
      const existing = await tx.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.organizationId, row.organizationId),
          eq(organizationMemberships.systemUserId, identity.user.id),
        ),
      });
      // Google may report a newer verified email than the stored account email.
      // Suspension invalidates older invitations even when email-based revocation missed one.
      if (existing?.status === 'SUSPENDED' && row.createdAt.getTime() <= existing.updatedAt.getTime())
        throw new ConsoleGoneError();
      if (existing && (existing.status === 'ACTIVE' || existing.role === 'OWNER'))
        throw new ConsoleConflictError('This account already has organization access');
      await tx
        .insert(organizationMemberships)
        .values({ organizationId: row.organizationId, systemUserId: identity.user.id, role: 'BUSINESS_DEVELOPER' })
        .onConflictDoUpdate({
          target: [organizationMemberships.organizationId, organizationMemberships.systemUserId],
          set: { role: 'BUSINESS_DEVELOPER', status: 'ACTIVE', updatedAt: new Date() },
        });
      await tx
        .update(invitations)
        .set({ status: 'ACCEPTED', acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(invitations.id, row.id));
      return { organizationId: row.organizationId };
    });
  }
}
