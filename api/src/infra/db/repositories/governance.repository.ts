import { Inject, Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, getTableColumns } from 'drizzle-orm';
import type { GovernanceProposal } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { organizationChangeRequests, organizationMemberships, systemUsers } from '../schema/auth.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { ConsoleOrganizationsRepository, ConsoleAccessError, ConsoleConflictError, ConsoleNotFoundError } from './console-organizations.repository.js';
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const reviewer = alias(systemUsers, 'reviewer');

@Injectable()
export class GovernanceRepository {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly access: ConsoleOrganizationsRepository,
  ) {}
  private async admin(tx: Tx, actor: string) {
    const [user] = await tx
      .select({ role: systemUsers.systemRole })
      .from(systemUsers)
      .where(eq(systemUsers.id, actor))
      .for('share');
    if (user?.role !== 'SYSTEM_ADMIN') throw new ConsoleAccessError('System Admin role required');
  }
  async propose(actor: string, orgId: string, input: GovernanceProposal, platform: boolean) {
    const action = async (tx: Tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
      if (!org) throw new ConsoleNotFoundError('Organization not found');
      if (input.requestType === 'REINSTATE' ? org.status !== 'SUSPENDED' : org.status !== 'ACTIVE')
        throw new ConsoleConflictError('Organization status does not permit this request');
      if (input.requestType === 'REINSTATE' && !platform)
        throw new ConsoleAccessError('Only System Admin can propose reinstatement');
      const owners = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, orgId),
            eq(organizationMemberships.role, 'OWNER'),
            eq(organizationMemberships.status, 'ACTIVE'),
          ),
        );
      const payload = {
        ...input.payload,
        expectedStatus: org.status,
        ...(input.requestType === 'UPDATE_PROFILE' ? { expectedName: org.name } : {}),
        requestedReason: input.reason,
        ...(input.requestType === 'TRANSFER_OWNERSHIP' ? { previousOwnerId: owners[0]?.systemUserId } : {}),
      };
      if (input.requestType === 'TRANSFER_OWNERSHIP') {
        if (owners.length !== 1) throw new ConsoleConflictError('Transfer requires exactly one active Owner');
        const target = await this.target(tx, orgId, input.payload.targetUserId!);
        Object.assign(payload, { targetName: target.fullName, targetEmail: target.email });
      }
      const [row] = await tx
        .insert(organizationChangeRequests)
        .values({
          organizationId: orgId,
          requestedById: actor,
          requestType: input.requestType,
          payload,
          reason: input.reason,
        })
        .returning();
      return row;
    };
    return platform
      ? this.db.transaction(async (tx) => {
          await this.admin(tx, actor);
          return action(tx);
        })
      : this.access.withAccess(actor, orgId, true, action);
  }
  private async target(tx: Tx, orgId: string, userId: string) {
    const [target] = await tx
      .select({
        role: organizationMemberships.role,
        status: organizationMemberships.status,
        subject: systemUsers.googleSubject,
        fullName: systemUsers.fullName,
        email: systemUsers.email,
      })
      .from(organizationMemberships)
      .innerJoin(systemUsers, eq(systemUsers.id, organizationMemberships.systemUserId))
      .where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.systemUserId, userId)));
    if (!target?.subject || target.role !== 'BUSINESS_DEVELOPER' || target.status !== 'ACTIVE')
      throw new ConsoleConflictError('New Owner must be an active Google-bound Developer in this organization');
    return target;
  }
  list(actor: string, query: { status?: string; cursor?: string; limit: number; organizationId?: string }) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const rows = await tx
        .select({
          ...getTableColumns(organizationChangeRequests),
          organizationName: organizations.name,
          requesterEmail: systemUsers.email,
          reviewerEmail: reviewer.email,
        })
        .from(organizationChangeRequests)
        .leftJoin(organizations, eq(organizations.id, organizationChangeRequests.organizationId))
        .innerJoin(systemUsers, eq(systemUsers.id, organizationChangeRequests.requestedById))
        .leftJoin(reviewer, eq(reviewer.id, organizationChangeRequests.reviewedById))
        .where(
          and(
            query.status ? eq(organizationChangeRequests.status, query.status as 'PENDING') : undefined,
            query.cursor ? gt(organizationChangeRequests.id, query.cursor) : undefined,
            query.organizationId ? eq(organizationChangeRequests.organizationId, query.organizationId) : undefined,
          ),
        )
        .orderBy(asc(organizationChangeRequests.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      if (more) rows.pop();
      return { items: rows, nextCursor: more ? rows.at(-1)!.id : null };
    });
  }
  async decide(actor: string, requestId: string, approve: boolean, reason: string) {
    // CREATE_ORGANIZATION shares OCT-39's single atomic implementation, including slug release.
    const candidate = await this.db.query.organizationChangeRequests.findFirst({
      where: eq(organizationChangeRequests.id, requestId),
    });
    if (candidate?.requestType === 'CREATE_ORGANIZATION') return this.access.decide(actor, requestId, approve, reason);
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const [request] = await tx
        .select()
        .from(organizationChangeRequests)
        .where(eq(organizationChangeRequests.id, requestId))
        .for('update');
      if (!request?.organizationId) throw new ConsoleNotFoundError('Request not found');
      if (request.status !== 'PENDING') throw new ConsoleConflictError('Request is already terminal');
      const [org] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.organizationId))
        .for('update');
      const payload = request.payload as {
        name?: string;
        targetUserId?: string;
        previousOwnerId?: string;
        expectedStatus?: string;
        expectedName?: string;
      };
      if (approve) {
        if (org.status !== payload.expectedStatus)
          throw new ConsoleConflictError('Organization changed since this request was submitted');
        switch (request.requestType) {
          case 'TRANSFER_OWNERSHIP': {
            const owners = await tx
              .select()
              .from(organizationMemberships)
              .where(
                and(
                  eq(organizationMemberships.organizationId, org.id),
                  eq(organizationMemberships.role, 'OWNER'),
                  eq(organizationMemberships.status, 'ACTIVE'),
                ),
              )
              .for('update');
            if (owners.length !== 1 || owners[0].systemUserId !== payload.previousOwnerId)
              throw new ConsoleConflictError('Ownership changed since submission');
            await this.target(tx, org.id, payload.targetUserId!);
            await tx
              .update(organizationMemberships)
              .set({ role: 'BUSINESS_DEVELOPER', updatedAt: new Date() })
              .where(eq(organizationMemberships.id, owners[0].id));
            await tx
              .update(organizationMemberships)
              .set({ role: 'OWNER', updatedAt: new Date() })
              .where(
                and(
                  eq(organizationMemberships.organizationId, org.id),
                  eq(organizationMemberships.systemUserId, payload.targetUserId!),
                ),
              );
            break;
          }
          case 'SUSPEND':
          case 'REINSTATE':
          case 'DEACTIVATE':
            await tx
              .update(organizations)
              .set({
                status:
                  request.requestType === 'SUSPEND'
                    ? 'SUSPENDED'
                    : request.requestType === 'REINSTATE'
                      ? 'ACTIVE'
                      : 'ARCHIVED',
                updatedAt: new Date(),
              })
              .where(eq(organizations.id, org.id));
            break;
          case 'UPDATE_PROFILE':
            if (org.name !== payload.expectedName)
              throw new ConsoleConflictError('Organization name changed since submission');
            if (!payload.name || payload.name.trim().length < 2 || payload.name.length > 160)
              throw new ConsoleConflictError('Request has an invalid display name');
            await tx
              .update(organizations)
              .set({ name: payload.name.trim(), updatedAt: new Date() })
              .where(eq(organizations.id, org.id));
            break;
          default:
            throw new ConsoleConflictError('Unsupported request type');
        }
      }
      await tx
        .update(organizationChangeRequests)
        .set({
          status: approve ? 'APPROVED' : 'REJECTED',
          reviewedById: actor,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          reason,
        })
        .where(eq(organizationChangeRequests.id, requestId));
      return { organizationId: org.id };
    });
  }
}
