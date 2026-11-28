import { Inject, Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, getTableColumns, inArray } from 'drizzle-orm';
import type { GovernanceProposal } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import {
  organizationChangeRequests,
  organizationChangeRequestSecrets,
  organizationMemberships,
  systemUsers,
} from '../schema/auth.schema.js';
import { organizationIdentityDetails, organizations } from '../schema/organizations.schema.js';
import { OrganizationIdentityCipher } from '../organization-identity.cipher.js';
import {
  applyIdentityChange,
  identityProblem,
  type IdentityChange,
  type IdentityState,
} from '../organization-identity.rules.js';
import {
  ConsoleOrganizationsRepository,
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleNotFoundError,
  ConsoleValidationError,
} from './console-organizations.repository.js';
import { withInitialOwners, requireSystemAdmin } from './console-access.js';
import { acceptCommand } from './operations.repository.js';
import {
  ORGANIZATION_BUDGET_TOP_UP_COMMAND,
  ORGANIZATION_EARN_RATE_CHANGE_COMMAND,
} from './organizations.repository.js';
import { programs } from '../schema/programs.schema.js';
import { operations } from '../schema/operations.schema.js';
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Organization = typeof organizations.$inferSelect;
const reviewer = alias(systemUsers, 'reviewer');

/** The legal details an `UPDATE_IDENTITY` request was proposed against, to detect a stale approval. */
interface IdentitySnapshot extends IdentityState {
  nationalIdLast4: string | null;
}
/** What an `UPDATE_IDENTITY` request stores: the new values, never the CCCD itself. */
type IdentityPayload = Omit<IdentityChange, 'nationalId'> & {
  nationalIdLast4?: string;
  expected: IdentitySnapshot;
};

@Injectable()
export class GovernanceRepository {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly access: ConsoleOrganizationsRepository,
    private readonly identityCipher: OrganizationIdentityCipher,
  ) {}
  private admin = requireSystemAdmin;
  private async identitySnapshot(tx: Tx, org: Organization): Promise<IdentitySnapshot> {
    const [details] = await tx
      .select({ last4: organizationIdentityDetails.nationalIdLast4 })
      .from(organizationIdentityDetails)
      .where(eq(organizationIdentityDetails.organizationId, org.id));
    return {
      organizationType: org.organizationType,
      legalName: org.legalName,
      taxId: org.taxId,
      representativeName: org.representativeName,
      nationalIdLast4: details?.last4 ?? null,
    };
  }
  /**
   * Checks an `UPDATE_IDENTITY` change against the organization's current details and returns the
   * payload to store. The caller holds the organization row FOR UPDATE, which serializes the
   * one-open-request check. The CCCD goes to `organization_change_request_secrets`, not the payload.
   */
  private async identityPayload(tx: Tx, org: Organization, change: IdentityChange): Promise<IdentityPayload> {
    const [open] = await tx
      .select({ id: organizationChangeRequests.id })
      .from(organizationChangeRequests)
      .where(
        and(
          eq(organizationChangeRequests.organizationId, org.id),
          eq(organizationChangeRequests.requestType, 'UPDATE_IDENTITY'),
          eq(organizationChangeRequests.status, 'PENDING'),
        ),
      );
    if (open) throw new ConsoleConflictError('This organization already has a legal details change waiting for review');
    if (change.organizationType && org.organizationType)
      throw new ConsoleValidationError('Organization type is already set');
    const expected = await this.identitySnapshot(tx, org);
    const problem = identityProblem(applyIdentityChange(expected, change), change.nationalId !== undefined);
    if (problem) throw new ConsoleValidationError(problem);
    const { nationalId, ...fields } = change;
    return { ...fields, ...(nationalId ? { nationalIdLast4: nationalId.slice(-4) } : {}), expected };
  }
  /**
   * Checks an `UPDATE_EARN_RATE` proposal against the organization's program and returns what the
   * request stores besides `earnBps`: the policy version it was proposed against, so an approval
   * after another rotation is refused rather than applied on top of it. The caller holds the
   * organization row FOR UPDATE, which serializes the one-open-request check.
   */
  private async earnRatePayload(tx: Tx, orgId: string, earnBps: number) {
    const program = await tx.query.programs.findFirst({ where: eq(programs.organizationId, orgId) });
    if (program?.status !== 'ACTIVE')
      throw new ConsoleConflictError('This organization has no active program to change the earn rate of');
    if (program.earnBps === earnBps) throw new ConsoleValidationError('The earn rate is already this value');
    const [open] = await tx
      .select({ id: organizationChangeRequests.id })
      .from(organizationChangeRequests)
      .where(
        and(
          eq(organizationChangeRequests.organizationId, orgId),
          eq(organizationChangeRequests.requestType, 'UPDATE_EARN_RATE'),
          eq(organizationChangeRequests.status, 'PENDING'),
        ),
      );
    if (open) throw new ConsoleConflictError('This organization already has an earn-rate change waiting for review');
    return { expectedPolicyVersion: program.policyVersion, previousEarnBps: program.earnBps };
  }
  /**
   * Queues an approved `UPDATE_EARN_RATE` for the worker holding the program admin key. Refused when
   * the program's policy moved since the proposal, or another earn-rate change has not finished
   * (or ended UNKNOWN and still needs an operator): two rotations must never race.
   */
  private async queueEarnRateChange(
    tx: Tx,
    orgId: string,
    requestId: string,
    payload: { earnBps?: number; expectedPolicyVersion?: number },
  ) {
    const program = await tx.query.programs.findFirst({ where: eq(programs.organizationId, orgId) });
    if (program?.status !== 'ACTIVE')
      throw new ConsoleConflictError('This organization has no active program to change the earn rate of');
    if (program.policyVersion !== payload.expectedPolicyVersion)
      throw new ConsoleConflictError('The earn rate changed since this request was submitted');
    const [inFlight] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.tenantId, orgId),
          eq(operations.commandType, ORGANIZATION_EARN_RATE_CHANGE_COMMAND),
          inArray(operations.status, ['PENDING', 'PROCESSING', 'UNKNOWN']),
        ),
      );
    if (inFlight)
      throw new ConsoleConflictError(
        'Another earn-rate change is still being applied or needs operator reconciliation',
      );
    // The worker holding the program admin key executes it; this process never signs.
    await acceptCommand(tx, {
      tenantId: orgId,
      idempotencyKey: `earn-rate-change-${requestId}`,
      commandType: ORGANIZATION_EARN_RATE_CHANGE_COMMAND,
      payload: { earnBps: payload.earnBps, fromPolicyVersion: program.policyVersion, changeRequestId: requestId },
    });
  }
  /** Applies an approved `UPDATE_IDENTITY` request, refusing it if the details moved since submission. */
  private async applyIdentity(tx: Tx, org: Organization, requestId: string, payload: IdentityPayload) {
    const current = await this.identitySnapshot(tx, org);
    const expected = payload.expected;
    if (
      !expected ||
      (Object.keys(current) as (keyof IdentitySnapshot)[]).some((key) => current[key] !== (expected[key] ?? null))
    )
      throw new ConsoleConflictError('Organization details changed since submission');
    const change: IdentityChange = {
      ...(payload.legalName !== undefined ? { legalName: payload.legalName } : {}),
      ...(payload.taxId !== undefined ? { taxId: payload.taxId } : {}),
      ...(payload.representativeName !== undefined ? { representativeName: payload.representativeName } : {}),
      ...(payload.organizationType !== undefined ? { organizationType: payload.organizationType } : {}),
    };
    const nationalIdLast4 = payload.nationalIdLast4;
    if (change.organizationType && org.organizationType)
      throw new ConsoleConflictError('Organization type is already set');
    const [secret] = await tx
      .select()
      .from(organizationChangeRequestSecrets)
      .where(eq(organizationChangeRequestSecrets.changeRequestId, requestId));
    if (nationalIdLast4 && !secret) throw new ConsoleConflictError('Request is missing its CCCD; ask for a new one');
    const problem = identityProblem(applyIdentityChange(current, change), secret !== undefined);
    if (problem) throw new ConsoleConflictError(problem);
    if (Object.keys(change).length > 0)
      await tx
        .update(organizations)
        .set({ ...change, updatedAt: new Date() })
        .where(eq(organizations.id, org.id));
    if (secret) {
      // Encrypted with the organization id as associated data, so it moves here unchanged.
      const details = {
        nationalIdEncrypted: secret.nationalIdEncrypted,
        nationalIdLast4: secret.nationalIdLast4,
        updatedAt: new Date(),
      };
      await tx
        .insert(organizationIdentityDetails)
        .values({ organizationId: org.id, ...details })
        .onConflictDoUpdate({ target: organizationIdentityDetails.organizationId, set: details });
    }
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
      const identity =
        input.requestType === 'UPDATE_IDENTITY' ? await this.identityPayload(tx, org, input.payload) : undefined;
      const earnRate =
        input.requestType === 'UPDATE_EARN_RATE'
          ? await this.earnRatePayload(tx, orgId, input.payload.earnBps!)
          : undefined;
      const payload = {
        ...(identity ?? input.payload),
        ...earnRate,
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
      if (identity && input.payload.nationalId)
        await tx.insert(organizationChangeRequestSecrets).values({
          changeRequestId: row.id,
          nationalIdEncrypted: this.identityCipher.encrypt(input.payload.nationalId, orgId),
          nationalIdLast4: input.payload.nationalId.slice(-4),
        });
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
      return { items: await withInitialOwners(tx, rows), nextCursor: more ? rows.at(-1)!.id : null };
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
        amount?: number;
        earnBps?: number;
        expectedPolicyVersion?: number;
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
          case 'BUDGET_TOP_UP': {
            const program = await tx.query.programs.findFirst({ where: eq(programs.organizationId, org.id) });
            if (program?.status !== 'ACTIVE')
              throw new ConsoleConflictError('This organization has no active program to top up');
            // The worker holding the program admin key executes it; this process never signs.
            await acceptCommand(tx, {
              tenantId: org.id,
              idempotencyKey: `budget-top-up-${request.id}`,
              commandType: ORGANIZATION_BUDGET_TOP_UP_COMMAND,
              payload: { amount: payload.amount, changeRequestId: request.id },
            });
            break;
          }
          case 'UPDATE_EARN_RATE':
            await this.queueEarnRateChange(tx, org.id, request.id, payload);
            break;
          case 'UPDATE_IDENTITY':
            await this.applyIdentity(tx, org, request.id, request.payload as IdentityPayload);
            break;
          default:
            throw new ConsoleConflictError('Unsupported request type');
        }
      }
      // A decided request no longer needs its CCCD: approval has copied it, rejection discards it.
      await tx
        .delete(organizationChangeRequestSecrets)
        .where(eq(organizationChangeRequestSecrets.changeRequestId, request.id));
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
