import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, desc, asc, and, sql, ne, isNull, count, inArray } from 'drizzle-orm';
import {
  DEFAULT_VOUCHER_REFUND_POLICY,
  VOUCHER_MIN_USE_WINDOW_MS,
  voucherUseDeadline,
  type ClaimVoucherResponse,
  type CreateVoucherRequest,
  type VoucherApprovalSnapshot,
  type VoucherBatchOutcome,
  type VoucherFieldDifference,
} from '@octap/contracts';
import { voucherRefundPolicies } from '../schema/voucher-refund-policies.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import {
  vouchers,
  voucherApprovalRequests,
  voucherImportBatches,
  voucherOwnerships,
} from '../schema/rewards.schema.js';
import { creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { operations } from '../schema/operations.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { organizationEndUsers, endUsers } from '../schema/members.schema.js';
import { enqueueWebhookEvent } from './webhooks.repository.js';
import {
  ABANDONED_POS_HOLD_GRACE_MS,
  VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
  releaseAbandonedPosHolds,
  expireDueBuckets,
  returnVoucherUnit,
  voucherClaimReference,
} from './credits.repository.js';
import {
  acceptCommand,
  canonicalJson,
  lockIdempotencyKey,
  OperationPayloadConflictError,
} from './operations.repository.js';
import { MemberEligibilityError } from './member-eligibility.js';
import { asOwnRole, withTenant } from '../rls.js';
import { tenantOf, withTenantOf } from './tenant-lookup.js';

type Voucher = typeof vouchers.$inferSelect;

/** Inside the minimum use window the contract refuses to claim or grant, so this refuses first. */
const expiresTooSoon = (voucher: Pick<Voucher, 'expiresAt'>): boolean =>
  voucher.expiresAt !== null && voucher.expiresAt.getTime() < Date.now() + VOUCHER_MIN_USE_WINDOW_MS;
type VoucherPatch = Partial<
  Omit<typeof vouchers.$inferInsert, 'id' | 'organizationId' | 'claimedCount' | 'createdAt' | 'updatedAt'>
>;

/** Every claim is accepted under this type, then becomes a reserve (paid) or a grant (free). */
const VOUCHER_CLAIM_COMMAND_TYPE = 'VOUCHER_CLAIM';
/** Worker-signed: freezes a voucher's terms on-chain. */
export const VOUCHER_PUBLISH_COMMAND_TYPE = 'VOUCHER_TERMS_PUBLISH';
/** Worker-signed: records a voucher for a customer without spending their points. */
export const VOUCHER_GRANT_COMMAND_TYPE = 'VOUCHER_GRANT';
/** Customer-signed: marks a voucher used. */
export const VOUCHER_USE_COMMAND_TYPE = 'VOUCHER_USE_RESERVE';

export interface ConfirmVoucherGrantParams {
  voucherOwnershipId: string;
  digest: string;
  /** `VoucherGranted.issued_at_ms` (see `voucherIssuedAt`). */
  issuedAt: Date;
}
const CLAIM_COMMAND_TYPES = [
  VOUCHER_CLAIM_COMMAND_TYPE,
  VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
  VOUCHER_GRANT_COMMAND_TYPE,
];
/** The promise: once publishing starts, these cannot change. */
const PUBLISHED_FIELDS = [
  'code',
  'title',
  'description',
  'pointsCost',
  'discountType',
  'discountValue',
  'terms',
  'startsAt',
  'expiresAt',
  'validForDays',
] as const;

/** A voucher rule a request broke. `RewardsService` maps `kind` to the HTTP status. */
export class RewardsRuleError extends Error {
  constructor(
    readonly kind: 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'RewardsRuleError';
  }
}

function sameVoucherField(key: (typeof PUBLISHED_FIELDS)[number], before: unknown, after: unknown): boolean {
  if (before instanceof Date || after instanceof Date) {
    return (before as Date | null)?.getTime() === (after as Date | null)?.getTime();
  }
  if (key === 'discountValue' && before !== null && after !== null && before !== undefined && after !== undefined) {
    return Number(before) === Number(after);
  }
  if (key === 'terms') return canonicalJson(before ?? null) === canonicalJson(after ?? null);
  return (before ?? null) === (after ?? null);
}

const notFound = (message: string) => new RewardsRuleError('NOT_FOUND', message);
const OWNER_ACTIVATION_NEEDS_SEEN =
  'This organization requires approval: send expectedUpdatedAt, the updatedAt of the voucher you reviewed';
const NOT_REVIEWED_IN_BATCH = 'Not among the vouchers you reviewed (seen); review the batch again';
const conflict = (message: string) => new RewardsRuleError('CONFLICT', message);
const invalid = (message: string) => new RewardsRuleError('INVALID', message);
const forbidden = (message: string) => new RewardsRuleError('FORBIDDEN', message);

/**
 * Who is writing a voucher, for the approval rules (OCT-59). An Owner never needs approval. A
 * Business Developer (`DEVELOPER`) writes drafts, and activates them only while the organization does
 * not require approval. An API key (`CREDENTIAL`) asking for `ACTIVE` there is queued for approval.
 */
export type VoucherActor =
  | { role: 'OWNER'; userId?: string }
  | { role: 'DEVELOPER'; userId: string }
  | { role: 'CREDENTIAL'; credentialId: string };
const OWNER: VoucherActor = { role: 'OWNER' };

/** Whoever acts, as the `*_user_id` / `*_credential_id` pair a voucher or a batch records. */
function actorIds(actor: VoucherActor): { userId: string | null; credentialId: string | null } {
  return actor.role === 'CREDENTIAL'
    ? { userId: null, credentialId: actor.credentialId }
    : { userId: actor.userId ?? null, credentialId: null };
}

/**
 * An Owner deciding on a voucher they reviewed: it must be the one they saw, its `updatedAt` unchanged
 * since (an edit, a withdrawal or a new submission all change it), or someone else's change would go
 * live unseen (OCT-324). Compared in milliseconds, the precision the API returns.
 */
function requireSeen(voucher: Voucher, seen: Date | null | undefined, missing: string) {
  if (!seen) throw invalid(missing);
  if (seen.getTime() !== voucher.updatedAt.getTime())
    throw conflict('This voucher changed since you reviewed it; review it again');
}

/** The terms an Owner reviews when a voucher is submitted, and that approving it publishes (OCT-324). */
function approvalSnapshot(voucher: Voucher): VoucherApprovalSnapshot {
  return {
    code: voucher.code,
    title: voucher.title,
    description: voucher.description,
    pointsCost: Number(voucher.pointsCost),
    discountType: voucher.discountType,
    discountValue: voucher.discountValue,
    terms: voucher.terms ?? null,
    totalSupply: voucher.totalSupply,
    perMemberLimit: voucher.perMemberLimit,
    startsAt: voucher.startsAt?.toISOString() ?? null,
    expiresAt: voucher.expiresAt?.toISOString() ?? null,
    validForDays: voucher.validForDays,
  };
}
type VoucherApprovalRequest = typeof voucherApprovalRequests.$inferSelect;
export type VoucherBatch = typeof voucherImportBatches.$inferSelect;

/** Every field a batch item sets, normalized: what a voucher created from it holds (OCT-303). */
export type VoucherBatchValues = Pick<
  typeof vouchers.$inferInsert,
  | 'title'
  | 'description'
  | 'pointsCost'
  | 'discountType'
  | 'discountValue'
  | 'terms'
  | 'totalSupply'
  | 'perMemberLimit'
  | 'startsAt'
  | 'expiresAt'
  | 'validForDays'
  | 'metadata'
>;

/** One item that passed validation, ready to write. `compare` lists how a stored voucher differs. */
export interface VoucherBatchWrite {
  index: number;
  code: string;
  values: VoucherBatchValues;
  compare: (stored: Voucher) => VoucherFieldDifference[];
}

/** What writing one item did; the service turns it into a `VoucherBatchItemResult`. */
export type VoucherBatchWriteResult =
  | { index: number; kind: 'created'; voucher: Voucher | null }
  | { index: number; kind: 'unchanged'; voucher: Voucher; moved: boolean }
  | { index: number; kind: 'conflict' | 'replaced'; voucher: Voucher; differences: VoucherFieldDifference[] };

/** What a batch action did to one voucher; `reason` is set when it `failed`. */
export interface VoucherBatchActionRow {
  voucher: Voucher;
  outcome: VoucherBatchOutcome;
  reason: string | null;
}

/**
 * Never published: its terms never reached the chain, so it may still be archived or activated. A
 * draft, or one paused while publishing whose publish then failed (`PAUSED` + `FAILED`).
 */
const neverPublished = (voucher: Voucher): boolean =>
  (voucher.status === 'DRAFT' || voucher.status === 'PAUSED') &&
  (voucher.publishStatus === 'NOT_PUBLISHED' || voucher.publishStatus === 'FAILED');

/**
 * Every method runs under the voucher's organization's RLS context (`withTenant`), so Postgres itself
 * hides other organizations' vouchers and the vouchers members hold. Methods that start from an id
 * alone (the chain worker, the indexer) first read that row's organization (`tenantOf`).
 */
@Injectable()
export class RewardsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Pass `tx` to join the caller's transaction (it runs in a savepoint there), e.g. so the console's
   * Owner check commits with the write. Without it, it opens its own transaction.
   */
  async createVoucher(
    data: Omit<CreateVoucherRequest, 'startsAt' | 'expiresAt'> & {
      organizationId: string;
      startsAt?: Date;
      expiresAt?: Date;
    },
    db: DrizzleDb = this.db,
    actor: VoucherActor = OWNER,
  ) {
    const status = data.status ?? 'ACTIVE';
    const creator = actorIds(actor);
    return withTenant(db, data.organizationId, async (tx) => {
      const [voucher] = await tx
        .insert(vouchers)
        // A voucher becomes ACTIVE only once the chain holds its terms.
        .values({
          ...data,
          status: status === 'ACTIVE' ? 'DRAFT' : status,
          createdByUserId: creator.userId,
          createdByCredentialId: creator.credentialId,
        })
        .onConflictDoNothing({ target: [vouchers.organizationId, vouchers.code] })
        .returning();
      if (!voucher) throw conflict('Voucher code already exists for this organization');
      if (status !== 'ACTIVE') return voucher;
      return (await this.activation(tx, data.organizationId, actor)) === 'PUBLISH'
        ? this.queuePublish(tx, voucher, actor)
        : this.queueApproval(tx, voucher, actor);
    });
  }

  /**
   * Whether activating publishes now or waits for an Owner. Read after the voucher's lock and FOR
   * SHARE, the order a claim takes them, so it cannot deadlock with one; turning the setting on or off
   * (which locks the organization FOR UPDATE) waits for this write instead of racing it.
   */
  private async activation(tx: DrizzleDb, organizationId: string, actor: VoucherActor): Promise<'PUBLISH' | 'QUEUE'> {
    if (actor.role === 'OWNER') return 'PUBLISH';
    if (!(await this.approvalRequired(tx, organizationId))) return 'PUBLISH';
    if (actor.role === 'DEVELOPER')
      throw forbidden('This organization requires approval: submit the voucher for approval instead of activating it');
    return 'QUEUE';
  }

  private async approvalRequired(tx: DrizzleDb, organizationId: string): Promise<boolean> {
    const [org] = await asOwnRole(tx, (own) =>
      own
        .select({ required: organizations.voucherApprovalRequired })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('share'),
    );
    return org?.required ?? false;
  }

  /** Waits for an Owner; the fields in `patch` are saved with it. */
  private async queueApproval(tx: DrizzleDb, voucher: Voucher, submitter: VoucherActor, patch: VoucherPatch = {}) {
    const [updated] = await tx
      .update(vouchers)
      .set({ ...patch, status: 'PENDING_APPROVAL', updatedAt: new Date() })
      .where(eq(vouchers.id, voucher.id))
      .returning();
    const by = actorIds(submitter);
    await tx.insert(voucherApprovalRequests).values({
      organizationId: voucher.organizationId,
      voucherId: voucher.id,
      submittedByUserId: by.userId,
      submittedByCredentialId: by.credentialId,
      // The terms as saved with it, so the Owner reviews exactly what approving publishes.
      snapshot: approvalSnapshot(updated),
    });
    return updated;
  }

  /**
   * Fixes the promise, including the refund policy current now, and queues it for the chain.
   * `activator` is recorded as who took it live: whoever activated it, or the Owner who approved it.
   */
  private async queuePublish(tx: DrizzleDb, voucher: Voucher, activator: VoucherActor, patch: VoucherPatch = {}) {
    const by = actorIds(activator);
    const [policy] = await tx
      .select()
      .from(voucherRefundPolicies)
      .where(eq(voucherRefundPolicies.organizationId, voucher.organizationId))
      .orderBy(desc(voucherRefundPolicies.version))
      .limit(1);
    const [updated] = await tx
      .update(vouchers)
      .set({
        ...patch,
        status: 'DRAFT',
        publishStatus: 'PUBLISHING',
        activatedByUserId: by.userId,
        activatedByCredentialId: by.credentialId,
        activatedAt: new Date(),
        refundPolicySnapshot: policy
          ? { ...policy.policy, version: policy.version }
          : { ...DEFAULT_VOUCHER_REFUND_POLICY },
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, voucher.id))
      .returning();
    await acceptCommand(tx, {
      tenantId: voucher.organizationId,
      // A failed publish can be retried by activating again, so each attempt has its own key.
      idempotencyKey: `voucher-publish:${voucher.id}:${randomUUID()}`,
      commandType: VOUCHER_PUBLISH_COMMAND_TYPE,
      payload: { voucherId: voucher.id },
    });
    return updated;
  }

  /** The chain holds the terms: an activation in progress takes effect. */
  async markVoucherPublished(voucherId: string, suiTermsId: string) {
    await withTenantOf(
      this.db,
      (db) => tenantOf.voucher(db, voucherId),
      (tx) => this.setPublished(tx, voucherId, suiTermsId),
      () => undefined,
    );
  }

  private async setPublished(tx: DrizzleDb, voucherId: string, suiTermsId: string) {
    await tx
      .update(vouchers)
      .set({
        publishStatus: 'PUBLISHED',
        suiTermsId,
        // Paused while publishing stays paused.
        status: sql`case when ${vouchers.status} = 'DRAFT' then 'ACTIVE'::voucher_status else ${vouchers.status} end`,
        updatedAt: new Date(),
      })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.publishStatus, 'PUBLISHING')));
  }

  /** The terms never reached the chain, so the voucher can be edited and activated again. */
  async failVoucherPublish(voucherId: string) {
    await withTenantOf(
      this.db,
      (db) => tenantOf.voucher(db, voucherId),
      (tx) =>
        tx
          .update(vouchers)
          .set({ publishStatus: 'FAILED', updatedAt: new Date() })
          .where(and(eq(vouchers.id, voucherId), eq(vouchers.publishStatus, 'PUBLISHING'))),
      () => undefined,
    );
  }

  /** Under the caller's organization: another organization's voucher is not found. */
  async findVoucherById(organizationId: string, id: string) {
    return withTenant(this.db, organizationId, (tx) => tx.query.vouchers.findFirst({ where: eq(vouchers.id, id) }));
  }

  async findVoucherByCode(organizationId: string, code: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx.query.vouchers.findFirst({
        where: and(eq(vouchers.organizationId, organizationId), eq(vouchers.code, code)),
      }),
    );
  }

  async listVouchersByOrganization(organizationId: string) {
    return withTenant(this.db, organizationId, (tx) =>
      tx.query.vouchers.findMany({
        where: eq(vouchers.organizationId, organizationId),
        orderBy: [desc(vouchers.createdAt)],
      }),
    );
  }

  /**
   * Serialize edits with claims; the domain validator sees the merged row under the lock. `db` joins
   * the caller's transaction, as in `createVoucher`. A caller that already holds a lock on the
   * organization row must hold it FOR SHARE: a claim locks this voucher first, then the organization.
   */
  async updateVoucher(
    organizationId: string,
    id: string,
    patch: VoucherPatch,
    validate: (merged: Voucher) => void,
    db: DrizzleDb = this.db,
    actor: VoucherActor = OWNER,
    /** The `updatedAt` the Owner reviewed, for an activation while approval is required (OCT-324). */
    expectedUpdatedAt: Date | null = null,
  ) {
    return withTenant(db, organizationId, async (tx) => {
      const current = await this.lockVoucher(tx, organizationId, id);
      if (current.status === 'PENDING_APPROVAL')
        throw conflict('The voucher is waiting for approval; withdraw it to make changes');
      if (current.status === 'ARCHIVED')
        throw conflict("This voucher's batch was archived; import its code again to use it");
      const merged = { ...current, ...patch };
      validate(merged);
      const onChain = current.publishStatus === 'PUBLISHING' || current.publishStatus === 'PUBLISHED';
      if (actor.role === 'DEVELOPER' && onChain)
        throw forbidden('Only an Owner can change a voucher once it is published');
      if (actor.role === 'DEVELOPER' && patch.status === 'PAUSED') throw forbidden('Only an Owner can pause a voucher');
      if (onChain) {
        for (const key of PUBLISHED_FIELDS) {
          if (!sameVoucherField(key, current[key], merged[key])) {
            throw conflict(`${key} cannot change after a voucher has been published; create a new voucher instead`);
          }
        }
      }
      if (merged.totalSupply !== null && merged.totalSupply < current.claimedCount)
        throw conflict('Supply cannot be less than the number already claimed');
      if (merged.status === 'ACTIVE' && expiresTooSoon(merged))
        throw invalid('A voucher must stay valid for at least 24 hours to be activated');
      const depleted = merged.totalSupply !== null && merged.claimedCount >= merged.totalSupply;
      if (patch.status === 'ACTIVE' && depleted) throw conflict('An exhausted voucher cannot be activated');
      const { status: requestedStatus, ...fields } = patch;
      if (requestedStatus === 'ACTIVE' && !onChain) {
        const activation = await this.activation(tx, organizationId, actor);
        // While approval is required, an Owner's activation is the approval of whatever the draft holds,
        // so it must be the draft they reviewed: a Business Developer may have edited it since.
        if (activation === 'PUBLISH' && actor.role === 'OWNER' && (await this.approvalRequired(tx, organizationId)))
          requireSeen(current, expectedUpdatedAt, OWNER_ACTIVATION_NEEDS_SEEN);
        return activation === 'PUBLISH'
          ? this.queuePublish(tx, current, actor, fields)
          : this.queueApproval(tx, current, actor, fields);
      }
      // DRAFT means an activation in progress here, so it would go ACTIVE when the chain confirms.
      if (requestedStatus === 'DRAFT' && onChain) {
        throw conflict('A published voucher cannot return to DRAFT; pause it instead');
      }
      // A repeat activation while publishing changes nothing: ACTIVE waits for the chain.
      const status =
        requestedStatus === 'ACTIVE' && current.publishStatus === 'PUBLISHING' ? current.status : requestedStatus;
      const [updated] = await tx
        .update(vouchers)
        .set({
          ...fields,
          ...(status ? { status } : {}),
          ...(depleted ? { status: 'DEPLETED' as const } : {}),
          updatedAt: new Date(),
        })
        .where(eq(vouchers.id, id))
        .returning();
      return updated;
    });
  }

  private async lockVoucher(tx: DrizzleDb, organizationId: string, id: string): Promise<Voucher> {
    const [current] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, id), eq(vouchers.organizationId, organizationId)))
      .for('update');
    if (!current) throw notFound('Voucher not found');
    return current;
  }

  /** A Business Developer asks an Owner to take a draft live. Only while the organization requires it. */
  async submitVoucher(organizationId: string, id: string, userId: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, async (tx) => {
      const current = await this.lockVoucher(tx, organizationId, id);
      if (current.status === 'PENDING_APPROVAL') throw conflict('The voucher is already waiting for approval');
      if (current.status === 'ARCHIVED')
        throw conflict("This voucher's batch was archived; import its code again to use it");
      if (current.publishStatus === 'PUBLISHING' || current.publishStatus === 'PUBLISHED')
        throw conflict('The voucher is already published');
      if (expiresTooSoon(current)) throw invalid('A voucher must stay valid for at least 24 hours to be activated');
      if (!(await this.approvalRequired(tx, organizationId)))
        throw conflict('This organization does not require approval: activate the voucher instead');
      return this.queueApproval(tx, current, { role: 'DEVELOPER', userId });
    });
  }

  /** Back to DRAFT, so it can be edited again. `userId` is whoever withdrew it. */
  async withdrawVoucher(organizationId: string, id: string, userId: string, db: DrizzleDb = this.db) {
    return this.decide(db, organizationId, id, userId, 'WITHDRAWN', null);
  }

  /**
   * An Owner's decision. Approving starts publishing, exactly as activating does, after the same
   * checks, made again now: days may have passed since it was submitted. Rejecting returns it to DRAFT.
   * `approvalRequestId` is the submission the Owner reviewed: one withdrawn and submitted again since
   * is refused, so a decision never lands on terms the Owner hasn't seen (OCT-324).
   */
  async reviewVoucher(
    organizationId: string,
    id: string,
    ownerId: string,
    decision:
      { approve: true; approvalRequestId: string } | { approve: false; approvalRequestId: string; reason: string },
    db: DrizzleDb = this.db,
  ) {
    return decision.approve
      ? this.decide(db, organizationId, id, ownerId, 'APPROVED', decision.approvalRequestId)
      : this.decide(db, organizationId, id, ownerId, 'REJECTED', decision.approvalRequestId, decision.reason);
  }

  private async decide(
    db: DrizzleDb,
    organizationId: string,
    id: string,
    userId: string,
    outcome: 'APPROVED' | 'REJECTED' | 'WITHDRAWN',
    /** The submission an Owner's decision is about; withdrawing takes back whichever one waits. */
    approvalRequestId: string | null,
    reason: string | null = null,
  ) {
    return withTenant(db, organizationId, async (tx) => {
      const current = await this.lockVoucher(tx, organizationId, id);
      if (current.status !== 'PENDING_APPROVAL') throw conflict('The voucher is not waiting for approval');
      const pending = await this.pendingApproval(tx, id);
      if (outcome !== 'WITHDRAWN' && (!pending || pending.id !== approvalRequestId))
        throw conflict('This voucher was submitted again since you reviewed it; review the new submission');
      if (outcome === 'APPROVED') {
        if (expiresTooSoon(current))
          throw invalid('A voucher must stay valid for at least 24 hours to be activated; reject it instead');
        // Nothing edits a voucher while it waits, so this only guards against a path that would.
        if (pending?.snapshot && canonicalJson(pending.snapshot) !== canonicalJson(approvalSnapshot(current)))
          throw conflict('The voucher changed after it was submitted; reject it, or have it submitted again');
      }
      await tx
        .update(voucherApprovalRequests)
        .set({ status: outcome, reviewedById: userId, reviewedAt: new Date(), reason })
        .where(and(eq(voucherApprovalRequests.voucherId, id), eq(voucherApprovalRequests.status, 'PENDING')));
      if (outcome === 'APPROVED') return this.queuePublish(tx, current, { role: 'OWNER', userId });
      const [updated] = await tx
        .update(vouchers)
        .set({ status: 'DRAFT', updatedAt: new Date() })
        .where(eq(vouchers.id, id))
        .returning();
      return updated;
    });
  }

  /** The submission waiting for a decision, if any (at most one per voucher). Call under the voucher's lock. */
  private async pendingApproval(tx: DrizzleDb, voucherId: string): Promise<VoucherApprovalRequest | undefined> {
    const [row] = await tx
      .select()
      .from(voucherApprovalRequests)
      .where(and(eq(voucherApprovalRequests.voucherId, voucherId), eq(voucherApprovalRequests.status, 'PENDING')));
    return row;
  }

  /** The latest approval request of each voucher, by voucher id. */
  async latestApprovals(
    organizationId: string,
    voucherIds: string[],
    db: DrizzleDb = this.db,
  ): Promise<Map<string, VoucherApprovalRequest>> {
    if (!voucherIds.length) return new Map();
    const rows = await withTenant(db, organizationId, (tx) =>
      tx
        .selectDistinctOn([voucherApprovalRequests.voucherId])
        .from(voucherApprovalRequests)
        .where(
          and(
            eq(voucherApprovalRequests.organizationId, organizationId),
            inArray(voucherApprovalRequests.voucherId, voucherIds),
          ),
        )
        .orderBy(voucherApprovalRequests.voucherId, desc(voucherApprovalRequests.submittedAt)),
    );
    return new Map(rows.map((row) => [row.voucherId, row]));
  }

  /**
   * Runs as the connection's own role (`asOwnRole`): the tenant role can neither read nor lock
   * `organizations` or a member's global user. Called where it is, after the voucher lock, so the
   * lock order (voucher, then organization) and the rule (settling accepted work stays allowed) hold.
   */
  private async requireActiveMember(tx: DrizzleDb, organizationId: string, memberId: string) {
    await asOwnRole(tx, (own) => this.checkActiveMember(own, organizationId, memberId));
  }

  private async checkActiveMember(tx: DrizzleDb, organizationId: string, memberId: string) {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('share');
    if (!org || org.status !== 'ACTIVE') throw new MemberEligibilityError('FORBIDDEN', 'Organization is not active');
    const [member] = await tx
      .select({ status: organizationEndUsers.status, userStatus: endUsers.status })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
      .where(and(eq(organizationEndUsers.id, memberId), eq(organizationEndUsers.organizationId, organizationId)))
      .for('share');
    if (!member) throw notFound('Member was not found for this organization');
    if (member.status !== 'ACTIVE' || member.userStatus !== 'ACTIVE')
      throw new MemberEligibilityError('FORBIDDEN', 'Member is not active');
  }

  /**
   * Atomically reserve stock and spendable points; only a chain verdict can confirm a paid claim.
   * Throws `RewardsRuleError` or `OperationPayloadConflictError`, which `RewardsService` maps.
   */
  async claimVoucher(
    organizationId: string,
    voucherId: string,
    memberId: string,
    idempotencyKey: string,
    options: { grant?: boolean } = {},
  ): Promise<ClaimVoucherResponse> {
    // Commit cleanup even if the subsequent claim fails its stock/balance checks.
    await withTenant(this.db, organizationId, (tx) =>
      releaseAbandonedPosHolds(tx, { organizationId, organizationEndUserId: memberId }, ABANDONED_POS_HOLD_GRACE_MS, {
        exceptIdempotencyKey: idempotencyKey,
      }),
    );
    return withTenant(this.db, organizationId, async (tx) => {
      await lockIdempotencyKey(tx, organizationId, idempotencyKey);
      const previous = await tx.query.operations.findFirst({
        where: and(eq(operations.tenantId, organizationId), eq(operations.idempotencyKey, idempotencyKey)),
      });
      if (previous && !CLAIM_COMMAND_TYPES.includes(previous.commandType))
        throw new OperationPayloadConflictError(idempotencyKey);
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: organizationId,
        idempotencyKey,
        commandType: VOUCHER_CLAIM_COMMAND_TYPE,
        payload: { voucherId, memberId, ...(options.grant ? { grant: true } : {}) },
      });
      if (!isNew) return this.resumeClaim(tx, organizationId, operation);

      const voucher = await this.lockClaimableVoucher(tx, organizationId, voucherId, memberId);
      const usedKey = await tx.query.loyaltyTransactions.findFirst({
        where: and(
          eq(loyaltyTransactions.organizationId, organizationId),
          eq(loyaltyTransactions.idempotencyKey, idempotencyKey),
        ),
      });
      if (usedKey) throw new OperationPayloadConflictError(idempotencyKey);
      // A grant gives the voucher whatever its price; the customer spends nothing.
      const pointsCost = options.grant ? 0 : Number(voucher.pointsCost);
      const ownershipId = randomUUID();
      const loyaltyTransactionId =
        pointsCost > 0
          ? await this.holdPoints(tx, { organizationId, memberId, voucher, pointsCost, idempotencyKey, ownershipId })
          : undefined;
      const ownership = await this.issueOwnership(tx, voucher, {
        memberId,
        ownershipId,
        loyaltyTransactionId,
        pendingOperationId: pointsCost > 0 ? undefined : operation.id,
      });

      const result: ClaimVoucherResponse = {
        voucherOwnershipId: ownership.id,
        refundPolicy: ownership.refundPolicySnapshot,
        voucherId,
        organizationEndUserId: memberId,
        serialCode: ownership.serialCode,
        status: ownership.status,
        pointsDeducted: 0,
        pointsCost,
        transactionId: loyaltyTransactionId ?? null,
        digest: null,
        transactionBytes: null,
        claimedAt: ownership.claimedAt.toISOString(),
        expiresAt: ownership.expiresAt?.toISOString() ?? null,
      };
      await tx
        .update(operations)
        .set({
          commandType: pointsCost > 0 ? VOUCHER_CLAIM_RESERVE_COMMAND_TYPE : VOUCHER_GRANT_COMMAND_TYPE,
          status: 'PENDING',
          payload: {
            voucherId,
            memberId,
            organizationEndUserId: memberId,
            pointsAmount: pointsCost,
            voucherOwnershipId: ownershipId,
            result,
          },
          updatedAt: new Date(),
        })
        .where(eq(operations.id, operation.id));
      return result;
    });
  }

  /** A retry under an accepted key: report the claim's current state instead of claiming again. */
  private async resumeClaim(tx: DrizzleDb, organizationId: string, operation: typeof operations.$inferSelect) {
    const saved = operation.payload as { result?: ClaimVoucherResponse };
    if (!saved?.result) throw conflict('Claim has no saved result; inspect the original operation');
    // A caller actively continuing an unsigned claim refreshes its abandonment clock.
    await tx
      .update(operations)
      .set({ updatedAt: new Date() })
      .where(
        and(eq(operations.id, operation.id), eq(operations.status, 'PENDING'), sql`${operations.suiTxDigest} is null`),
      );
    return this.getClaim(organizationId, saved.result.voucherOwnershipId, tx);
  }

  /** Locks the catalog row (stock) and checks this member may claim it now. */
  private async lockClaimableVoucher(tx: DrizzleDb, organizationId: string, voucherId: string, memberId: string) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.organizationId, organizationId)))
      .for('update');
    if (!voucher) throw notFound('Voucher not found');
    await this.requireActiveMember(tx, organizationId, memberId);
    const now = new Date();
    if (voucher.status !== 'ACTIVE') throw invalid(`Voucher is not active (current status: ${voucher.status})`);
    if (!voucher.suiTermsId) throw invalid('Voucher terms are not published on-chain');
    if (voucher.startsAt && voucher.startsAt > now) throw invalid('Voucher has not started');
    if (expiresTooSoon(voucher)) throw invalid('Voucher expires too soon to be issued');
    if (voucher.totalSupply !== null && voucher.claimedCount >= voucher.totalSupply)
      throw invalid('Voucher is completely depleted');
    if (voucher.perMemberLimit !== null) {
      // Under the voucher's row lock taken above, so two claims by one member count one after the other.
      // No database constraint backs this: any new path that inserts or revives an ownership must go
      // through this method. Cancelled vouchers (failed, abandoned, or refunded while unused) don't
      // count; used and expired ones do, even when refunded, since refunds keep REDEEMED/EXPIRED.
      const [{ held }] = await tx
        .select({ held: count() })
        .from(voucherOwnerships)
        .where(
          and(
            eq(voucherOwnerships.voucherId, voucherId),
            eq(voucherOwnerships.organizationEndUserId, memberId),
            ne(voucherOwnerships.status, 'CANCELLED'),
          ),
        );
      if (held >= voucher.perMemberLimit)
        throw conflict(
          `Member has reached this voucher's per-member limit (${voucher.perMemberLimit}); cancelled vouchers don't count`,
        );
    }
    const pointsCost = Number(voucher.pointsCost);
    if (!Number.isSafeInteger(pointsCost) || pointsCost < 0) throw invalid('Voucher points cost is invalid');
    return voucher;
  }

  /** Holds `pointsCost` in `pendingRedemption` behind a PENDING REDEEM; returns that transaction's id. */
  private async holdPoints(
    tx: DrizzleDb,
    params: {
      organizationId: string;
      memberId: string;
      voucher: Voucher;
      pointsCost: number;
      idempotencyKey: string;
      ownershipId: string;
    },
  ) {
    const { organizationId, memberId, voucher, pointsCost } = params;
    // This takes the same ownership lock used by other balance writers before spending.
    await expireDueBuckets(tx, { organizationId, organizationEndUserId: memberId });
    const balance = await tx.query.creditOwnerships.findFirst({
      where: eq(creditOwnerships.organizationEndUserId, memberId),
    });
    if (
      balance &&
      (!Number.isSafeInteger(Number(balance.confirmedBalance)) ||
        !Number.isSafeInteger(Number(balance.pendingRedemption)) ||
        Number(balance.pendingRedemption) < 0 ||
        !Number.isSafeInteger(Number(balance.lifetimeRedeemed) + pointsCost))
    )
      throw invalid('Member balance exceeds supported point precision');
    const available = balance ? Number(balance.confirmedBalance) - Number(balance.pendingRedemption) : 0;
    if (!balance || available < pointsCost) throw invalid('Insufficient points');
    if (!balance.suiCreditAccountId) throw invalid('Member has no on-chain CreditAccount yet');
    // The ownership lock can wait on another balance writer. Recheck expiry after waiting.
    if (expiresTooSoon(voucher)) throw invalid('Voucher expires too soon to be issued');

    const [transaction] = await tx
      .insert(loyaltyTransactions)
      .values({
        organizationId,
        organizationEndUserId: memberId,
        transactionType: 'REDEEM',
        pointsAmount: pointsCost,
        idempotencyKey: params.idempotencyKey,
        receiptReference: voucherClaimReference(params.ownershipId),
        status: 'PENDING',
        metadata: { voucherId: voucher.id, voucherOwnershipId: params.ownershipId },
      })
      .returning();
    await tx
      .update(creditOwnerships)
      .set({ pendingRedemption: Number(balance.pendingRedemption) + pointsCost, updatedAt: new Date() })
      .where(eq(creditOwnerships.id, balance.id));
    return transaction.id;
  }

  /** Issues the coupon (RESERVED until the chain confirms) and takes its unit from the catalog. */
  private async issueOwnership(
    tx: DrizzleDb,
    voucher: Voucher,
    params: { memberId: string; ownershipId: string; loyaltyTransactionId?: string; pendingOperationId?: string },
  ) {
    // The policy published with the terms, which is what this voucher promised.
    const refundPolicySnapshot = voucher.refundPolicySnapshot ?? { ...DEFAULT_VOUCHER_REFUND_POLICY };
    const [ownership] = await tx
      .insert(voucherOwnerships)
      .values({
        id: params.ownershipId,
        refundPolicySnapshot,
        voucherId: voucher.id,
        organizationEndUserId: params.memberId,
        status: 'RESERVED',
        pendingOperationId: params.pendingOperationId,
        serialCode: `${voucher.code.toUpperCase()}-${randomBytes(8).toString('hex').toUpperCase()}`,
        loyaltyTransactionId: params.loyaltyTransactionId,
        // Provisional: fixed again when it becomes AVAILABLE, which is when the chain issues it.
        expiresAt: voucherUseDeadline(voucher, new Date()),
      })
      .returning();
    const claimedCount = voucher.claimedCount + 1;
    await tx
      .update(vouchers)
      .set({
        claimedCount,
        status: voucher.totalSupply !== null && claimedCount >= voucher.totalSupply ? 'DEPLETED' : 'ACTIVE',
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, voucher.id));
    return ownership;
  }

  /** Tenant-scoped persisted state, also used after recovery/indexer settlement. */
  async getClaim(organizationId: string, ownershipId: string, db: DrizzleDb = this.db): Promise<ClaimVoucherResponse> {
    return withTenant(db, organizationId, (tx) => this.readClaim(tx, organizationId, ownershipId));
  }

  private async readClaim(db: DrizzleDb, organizationId: string, ownershipId: string): Promise<ClaimVoucherResponse> {
    const [row] = await db
      .select({
        ownership: voucherOwnerships,
        pointsCost: vouchers.pointsCost,
        transactionStatus: loyaltyTransactions.status,
      })
      .from(voucherOwnerships)
      .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
      .leftJoin(loyaltyTransactions, eq(loyaltyTransactions.id, voucherOwnerships.loyaltyTransactionId))
      .where(and(eq(voucherOwnerships.id, ownershipId), eq(vouchers.organizationId, organizationId)));
    if (!row) throw notFound('Voucher claim not found');
    const o = row.ownership;
    return {
      voucherOwnershipId: o.id,
      refundPolicy: o.refundPolicySnapshot,
      voucherId: o.voucherId,
      organizationEndUserId: o.organizationEndUserId,
      serialCode: o.serialCode,
      status: o.status,
      pointsCost: o.loyaltyTransactionId ? Number(row.pointsCost) : 0,
      pointsDeducted: row.transactionStatus === 'CONFIRMED' ? Number(row.pointsCost) : 0,
      transactionId: o.loyaltyTransactionId,
      digest: null,
      transactionBytes: null,
      claimedAt: o.claimedAt.toISOString(),
      expiresAt: o.expiresAt?.toISOString() ?? null,
    };
  }

  /** A voucher with its catalog row, for the chain worker and the indexer. */
  async findOwnershipWithVoucher(voucherOwnershipId: string) {
    return withTenantOf(
      this.db,
      (db) => tenantOf.voucherOwnership(db, voucherOwnershipId),
      (tx) =>
        tx.query.voucherOwnerships.findFirst({
          where: eq(voucherOwnerships.id, voucherOwnershipId),
          with: { voucher: true },
        }),
      () => undefined,
    );
  }

  private async operationKey(tx: DrizzleDb, operationId: string | null) {
    if (!operationId) return null;
    const operation = await tx.query.operations.findFirst({ where: eq(operations.id, operationId) });
    return operation ? { tenantId: operation.tenantId, idempotencyKey: operation.idempotencyKey } : null;
  }

  /**
   * The chain recorded a grant or free claim. Returns the command to settle, or null when the voucher
   * is not waiting for this. `issuedAt` is the event's `issued_at_ms`: the voucher's own deadline
   * counts from it, as the chain's does, however late this confirmation runs.
   */
  async confirmVoucherGrant(params: ConfirmVoucherGrantParams, db: DrizzleDb = this.db) {
    return withTenantOf(
      db,
      (lookup) => tenantOf.voucherOwnership(lookup, params.voucherOwnershipId),
      (tx) => this.settleGrant(tx, params),
      () => null,
    );
  }

  private async settleGrant(tx: DrizzleDb, params: ConfirmVoucherGrantParams) {
    const [ownership] = await tx
      .select()
      .from(voucherOwnerships)
      .where(eq(voucherOwnerships.id, params.voucherOwnershipId))
      .for('update');
    if (!ownership || ownership.status !== 'RESERVED' || ownership.loyaltyTransactionId) return null;
    const key = await this.operationKey(tx, ownership.pendingOperationId);
    const voucher = await tx.query.vouchers.findFirst({ where: eq(vouchers.id, ownership.voucherId) });
    // The foreign key keeps the catalog row; failing loudly beats a TypeError mid-settlement.
    if (!voucher) throw new Error(`voucher ${ownership.voucherId} of ownership ${ownership.id} is missing`);
    const [updated] = await tx
      .update(voucherOwnerships)
      .set({
        status: 'AVAILABLE',
        pendingOperationId: null,
        expiresAt: voucherUseDeadline(voucher, params.issuedAt),
        updatedAt: new Date(),
      })
      .where(eq(voucherOwnerships.id, ownership.id))
      .returning();
    await enqueueWebhookEvent(tx, {
      organizationId: voucher.organizationId,
      eventType: 'voucher.granted',
      payload: {
        voucherOwnershipId: updated.id,
        voucherId: updated.voucherId,
        organizationEndUserId: updated.organizationEndUserId,
        serialCode: updated.serialCode,
        status: updated.status,
        expiresAt: updated.expiresAt?.toISOString() ?? null,
        blockchainDigest: params.digest,
      },
    });
    return { key };
  }

  /** A grant definitively failed on-chain: the voucher is cancelled and its unit returns to the catalog. */
  async failVoucherGrant(voucherOwnershipId: string) {
    await withTenantOf(
      this.db,
      (db) => tenantOf.voucherOwnership(db, voucherOwnershipId),
      (tx) => this.cancelGrant(tx, voucherOwnershipId),
      () => undefined,
    );
  }

  private async cancelGrant(tx: DrizzleDb, voucherOwnershipId: string) {
    const found = await tx.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.id, voucherOwnershipId) });
    if (!found) return;
    await tx.select({ id: vouchers.id }).from(vouchers).where(eq(vouchers.id, found.voucherId)).for('update');
    const [cancelled] = await tx
      .update(voucherOwnerships)
      .set({ status: 'CANCELLED', pendingOperationId: null, updatedAt: new Date() })
      .where(and(eq(voucherOwnerships.id, voucherOwnershipId), eq(voucherOwnerships.status, 'RESERVED')))
      .returning();
    if (cancelled) await returnVoucherUnit(tx, found.voucherId);
  }

  /**
   * Accepts a request to use a voucher and blocks refunds until it settles. Nothing is marked used
   * here: only the customer's signature can do that. A retry under the same key reports the same use.
   */
  async reserveVoucherUse(params: { organizationId: string; serialCode: string; idempotencyKey: string }) {
    return withTenant(this.db, params.organizationId, async (tx) => {
      await lockIdempotencyKey(tx, params.organizationId, params.idempotencyKey);
      const found = await tx.query.voucherOwnerships.findFirst({
        where: eq(voucherOwnerships.serialCode, params.serialCode),
      });
      if (!found) throw notFound('Voucher serial not found');
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, found.voucherId), eq(vouchers.organizationId, params.organizationId)))
        .for('share');
      if (!voucher) throw notFound('Voucher serial not found');
      await this.requireActiveMember(tx, params.organizationId, found.organizationEndUserId);
      const [ownership] = await tx
        .select()
        .from(voucherOwnerships)
        .where(eq(voucherOwnerships.id, found.id))
        .for('update');
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: VOUCHER_USE_COMMAND_TYPE,
        payload: { voucherOwnershipId: ownership.id, organizationEndUserId: ownership.organizationEndUserId },
      });
      if (operation.commandType !== VOUCHER_USE_COMMAND_TYPE)
        throw new OperationPayloadConflictError(params.idempotencyKey);
      if (!isNew) {
        if (operation.status === 'PENDING' && !operation.suiTxDigest) {
          // The caller is still working on it: restart its abandonment clock.
          await tx.update(operations).set({ updatedAt: new Date() }).where(eq(operations.id, operation.id));
        }
        return { ownership, voucher, operation, isNew };
      }

      if (ownership.status !== 'AVAILABLE')
        throw invalid(`Voucher cannot be used; status is currently ${ownership.status}`);
      if (ownership.expiresAt && ownership.expiresAt.getTime() <= Date.now()) throw invalid('Voucher has expired');
      if (!voucher.suiTermsId) throw invalid('This voucher has no on-chain record to use');
      if (ownership.pendingOperationId) {
        // A use nobody signed can't land once it is FAILED, so a new attempt replaces it. One already
        // submitted has an outcome to wait for.
        const [replaced] = await tx
          .update(operations)
          .set({ status: 'FAILED', errorMessage: 'Replaced by a new voucher use', updatedAt: new Date() })
          .where(
            and(
              eq(operations.id, ownership.pendingOperationId),
              eq(operations.status, 'PENDING'),
              isNull(operations.suiTxDigest),
            ),
          )
          .returning({ id: operations.id });
        if (!replaced) throw conflict('Another use of this voucher is still in progress');
      }
      await tx
        .update(voucherOwnerships)
        .set({ pendingOperationId: operation.id, updatedAt: new Date() })
        .where(eq(voucherOwnerships.id, ownership.id));
      return { ownership, voucher, operation, isNew };
    });
  }

  /**
   * The chain marked this voucher used, so PostgreSQL follows, whoever sent the transaction. Exactly
   * one AVAILABLE -> REDEEMED transition queues `voucher.redeemed`. Returns null only when the voucher
   * was already taken back here, which `ChainOutcomeReconciler`'s logs surface for a human.
   */
  async confirmVoucherUse(params: { voucherOwnershipId: string; digest: string }, db: DrizzleDb = this.db) {
    return withTenantOf(
      db,
      (lookup) => tenantOf.voucherOwnership(lookup, params.voucherOwnershipId),
      (tx) => this.settleUse(tx, params),
      () => null,
    );
  }

  private async settleUse(tx: DrizzleDb, params: { voucherOwnershipId: string; digest: string }) {
    const found = await tx.query.voucherOwnerships.findFirst({
      where: eq(voucherOwnerships.id, params.voucherOwnershipId),
    });
    if (!found) return null;
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, found.voucherId)).for('share');
    const [ownership] = await tx
      .select()
      .from(voucherOwnerships)
      .where(eq(voucherOwnerships.id, found.id))
      .for('update');
    const key = await this.operationKey(tx, ownership.pendingOperationId);
    if (ownership.status === 'REDEEMED') return { ownership, voucher, key, applied: false };
    if (ownership.status !== 'AVAILABLE') return null;
    const [updated] = await tx
      .update(voucherOwnerships)
      .set({ status: 'REDEEMED', redeemedAt: new Date(), pendingOperationId: null, updatedAt: new Date() })
      .where(eq(voucherOwnerships.id, ownership.id))
      .returning();
    await enqueueWebhookEvent(tx, {
      organizationId: voucher.organizationId,
      eventType: 'voucher.redeemed',
      payload: {
        voucherOwnershipId: updated.id,
        voucherId: updated.voucherId,
        organizationEndUserId: updated.organizationEndUserId,
        serialCode: updated.serialCode,
        status: updated.status,
        redeemedAt: updated.redeemedAt!.toISOString(),
        voucherTitle: voucher.title,
        discountType: voucher.discountType,
        discountValue: voucher.discountValue,
        blockchainDigest: params.digest,
      },
    });
    return { ownership: updated, voucher, key, applied: true };
  }

  /**
   * Ends a use that will not land: the voucher stays AVAILABLE and refunds are allowed again.
   * With `onlyIfUnsubmitted` it yields to a finalize that already pinned a digest, and returns false.
   */
  async failVoucherUse(params: { operationId: string; voucherOwnershipId: string; onlyIfUnsubmitted?: boolean }) {
    return withTenantOf(
      this.db,
      (db) => tenantOf.operation(db, params.operationId),
      (tx) => this.releaseUse(tx, params),
      () => false,
    );
  }

  private async releaseUse(
    tx: DrizzleDb,
    params: { operationId: string; voucherOwnershipId: string; onlyIfUnsubmitted?: boolean },
  ) {
    const [command] = await tx.select().from(operations).where(eq(operations.id, params.operationId)).for('update');
    if (!command) return false;
    if (params.onlyIfUnsubmitted && command.suiTxDigest) return false;
    await tx
      .update(voucherOwnerships)
      .set({ pendingOperationId: null, updatedAt: new Date() })
      .where(
        and(
          eq(voucherOwnerships.id, params.voucherOwnershipId),
          eq(voucherOwnerships.pendingOperationId, params.operationId),
        ),
      );
    return true;
  }

  async listOwnershipsByMember(organizationId: string, organizationEndUserId: string) {
    return withTenant(this.db, organizationId, (tx) =>
      tx.query.voucherOwnerships.findMany({
        where: eq(voucherOwnerships.organizationEndUserId, organizationEndUserId),
        with: { voucher: true },
        orderBy: [desc(voucherOwnerships.claimedAt)],
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Voucher batches (OCT-303)
  // ---------------------------------------------------------------------------------------------

  /**
   * Writes a batch's items in one transaction, each in its own savepoint, so a crash leaves no half
   * batch. Items arrive already checked (`checkBatchItems` turns every rule error into that item's
   * `error` before the database), so nothing here is expected to throw; if something does, the whole
   * call fails and nothing is written. Items run in `code` order, so two batches touching
   * the same codes lock them in the same order and cannot deadlock. The batch row is written first
   * (the vouchers' key needs it) and removed again when no item landed in it, so a sync that brings
   * nothing new leaves no empty batch. `dryRun` reads and classifies, but writes nothing.
   */
  async createVoucherBatch(
    organizationId: string,
    items: VoucherBatchWrite[],
    creator: VoucherActor,
    dryRun: boolean,
    name: string | null,
    db: DrizzleDb = this.db,
  ): Promise<{ batch: VoucherBatch | null; results: VoucherBatchWriteResult[] }> {
    return withTenant(db, organizationId, async (tx) => {
      let batch: VoucherBatch | null = null;
      if (!dryRun) {
        [batch] = await tx
          .insert(voucherImportBatches)
          .values({
            organizationId,
            name,
            source: creator.role === 'CREDENTIAL' ? 'API' : 'CONSOLE',
            createdByUserId: creator.role === 'CREDENTIAL' ? null : (creator.userId ?? null),
            createdByCredentialId: creator.role === 'CREDENTIAL' ? creator.credentialId : null,
          })
          .returning();
      }
      const results: VoucherBatchWriteResult[] = [];
      for (const item of [...items].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
        results.push(await tx.transaction((sp) => this.writeBatchItem(sp, organizationId, item, batch)));
      }
      results.sort((a, b) => a.index - b.index);
      const landed = results.some(
        (r) => r.kind === 'created' || r.kind === 'replaced' || (r.kind === 'unchanged' && r.moved),
      );
      if (batch && !landed) {
        await tx.delete(voucherImportBatches).where(eq(voucherImportBatches.id, batch.id));
        batch = null;
      }
      return { batch, results };
    });
  }

  private async writeBatchItem(
    tx: DrizzleDb,
    organizationId: string,
    item: VoucherBatchWrite,
    batch: VoucherBatch | null,
  ): Promise<VoucherBatchWriteResult> {
    // No batch row means a dry run: read and classify, write nothing.
    let stored = await this.voucherByCode(tx, organizationId, item.code, batch !== null);
    if (!stored) {
      if (!batch) return { index: item.index, kind: 'created', voucher: null };
      const [created] = await tx
        .insert(vouchers)
        .values({
          ...item.values,
          organizationId,
          code: item.code,
          status: 'DRAFT',
          importBatchId: batch.id,
          createdByUserId: batch.createdByUserId,
          createdByCredentialId: batch.createdByCredentialId,
        })
        .onConflictDoNothing({ target: [vouchers.organizationId, vouchers.code] })
        .returning();
      if (created) return { index: item.index, kind: 'created', voucher: created };
      // Another batch inserted this code since the read above: classify against its voucher.
      stored = await this.voucherByCode(tx, organizationId, item.code, true);
      if (!stored) throw conflict(`Voucher code ${item.code} changed while the batch was written; try again`);
    }
    const differences = item.compare(stored);
    // Only an ARCHIVED voucher (a draft of an archived batch, never published) gives its code up to a
    // new batch. Its status is on the locked row itself, so nothing else needs reading or locking.
    const released = stored.status === 'ARCHIVED';
    if (!released) {
      return differences.length
        ? { index: item.index, kind: 'conflict', voucher: stored, differences }
        : { index: item.index, kind: 'unchanged', voucher: stored, moved: false };
    }
    if (!batch) {
      return differences.length
        ? { index: item.index, kind: 'replaced', voucher: stored, differences }
        : { index: item.index, kind: 'unchanged', voucher: stored, moved: true };
    }
    const [updated] = await tx
      .update(vouchers)
      .set({
        ...(differences.length
          ? // The terms never reached the chain, so nothing of the old attempt is kept. The file's
            // terms are this batch's creator's now.
            {
              ...item.values,
              publishStatus: 'NOT_PUBLISHED' as const,
              refundPolicySnapshot: null,
              suiTermsId: null,
              createdByUserId: batch.createdByUserId,
              createdByCredentialId: batch.createdByCredentialId,
              activatedByUserId: null,
              activatedByCredentialId: null,
              activatedAt: null,
            }
          : {}),
        status: 'DRAFT',
        importBatchId: batch.id,
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, stored.id))
      .returning();
    return differences.length
      ? { index: item.index, kind: 'replaced', voucher: updated, differences }
      : { index: item.index, kind: 'unchanged', voucher: updated, moved: true };
  }

  private async voucherByCode(tx: DrizzleDb, organizationId: string, code: string, lock: boolean) {
    const query = tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.organizationId, organizationId), eq(vouchers.code, code)));
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  /**
   * Runs `act` on each voucher of the batch, in `code` order (the order other batch writes lock them
   * in), each in its own savepoint, after locking the batch row, so an archive cannot race it. A
   * rule error (`RewardsRuleError`) on one voucher is that voucher's `failed` result; anything else
   * aborts the call. `refuseArchived` is the 409 for actions an archived batch no longer allows.
   */
  private async eachBatchVoucher(
    organizationId: string,
    batchId: string,
    db: DrizzleDb,
    refuseArchived: string | null,
    act: (tx: DrizzleDb, current: Voucher) => Promise<VoucherBatchActionRow>,
    prepare?: (tx: DrizzleDb, batch: VoucherBatch) => Promise<VoucherBatch>,
  ): Promise<{ batch: VoucherBatch; results: VoucherBatchActionRow[] }> {
    return withTenant(db, organizationId, async (tx) => {
      const locked = await this.lockBatch(tx, organizationId, batchId);
      if (refuseArchived && locked.archivedAt) throw conflict(refuseArchived);
      const batch = prepare ? await prepare(tx, locked) : locked;
      const members = await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(and(eq(vouchers.organizationId, organizationId), eq(vouchers.importBatchId, batchId)))
        .orderBy(asc(vouchers.code));
      const results: VoucherBatchActionRow[] = [];
      for (const { id } of members) {
        results.push(
          await tx.transaction(async (sp) => {
            const current = await this.lockVoucher(sp, organizationId, id);
            try {
              return await sp.transaction((step) => act(step, current));
            } catch (error) {
              if (!(error instanceof RewardsRuleError)) throw error;
              return { voucher: current, outcome: 'failed' as const, reason: error.message };
            }
          }),
        );
      }
      return { batch, results };
    });
  }

  /**
   * Activates every voucher of the batch that can be, with the same checks and the same paths as
   * activating it on its own (`queuePublish`, or `queueApproval` when the organization requires
   * approval and `actor` is not an Owner). An Owner's activation also approves the vouchers waiting
   * for approval. An Owner decides only on what they reviewed (OCT-324): `seen` holds each voucher's
   * `updatedAt` as they saw it, and a waiting voucher, or (while approval is required) a draft, that
   * changed since or isn't in it is `failed`, with the reason. Vouchers already published or publishing,
   * and waiting ones for anyone but an Owner, are `skipped`, which makes calling it again safe. The
   * program check belongs to the caller (a 422 for the whole call).
   */
  async activateVoucherBatch(
    organizationId: string,
    batchId: string,
    actor: VoucherActor,
    db: DrizzleDb = this.db,
    seen: ReadonlyMap<string, Date> | null = null,
  ) {
    return this.eachBatchVoucher(
      organizationId,
      batchId,
      db,
      'This batch is archived and can no longer be activated',
      async (tx, current) => {
        // An Owner is the approver (OCT-59): activating a reviewed batch approves what waits in it, the
        // way approving one voucher does (the same checks, then publishing). Anyone else skips it.
        if (current.status === 'PENDING_APPROVAL') {
          if (actor.role !== 'OWNER' || !actor.userId) return { voucher: current, outcome: 'skipped', reason: null };
          requireSeen(current, seen?.get(current.id), NOT_REVIEWED_IN_BATCH);
          // Unchanged since the Owner saw it, so the submission waiting now is the one they reviewed.
          const pending = await this.pendingApproval(tx, current.id);
          const voucher = await this.reviewVoucher(
            organizationId,
            current.id,
            actor.userId,
            { approve: true, approvalRequestId: pending?.id ?? '' },
            tx,
          );
          return { voucher, outcome: 'publishing', reason: null };
        }
        if (!neverPublished(current)) return { voucher: current, outcome: 'skipped', reason: null };
        const required = await this.approvalRequired(tx, organizationId);
        // While approval is required, an Owner's activation approves the draft as it is now.
        if (required && actor.role === 'OWNER') requireSeen(current, seen?.get(current.id), NOT_REVIEWED_IN_BATCH);
        if (expiresTooSoon(current)) throw invalid('A voucher must stay valid for at least 24 hours to be activated');
        if (current.totalSupply !== null && current.claimedCount >= current.totalSupply)
          throw conflict('An exhausted voucher cannot be activated');
        // Like `activation`, but a Business Developer is queued, not refused: a batch's activation is
        // its submission when approval is required (OCT-59).
        const queue = actor.role !== 'OWNER' && required;
        if (queue)
          return { voucher: await this.queueApproval(tx, current, actor), outcome: 'pendingApproval', reason: null };
        const queued = await this.queuePublish(tx, current, actor);
        if (current.status !== 'PAUSED') return { voucher: queued, outcome: 'publishing', reason: null };
        // Paused while its publish failed: publishing again keeps the Owner's pause, as `setPublished` does.
        const [voucher] = await tx
          .update(vouchers)
          .set({ status: 'PAUSED', updatedAt: new Date() })
          .where(eq(vouchers.id, current.id))
          .returning();
        return { voucher, outcome: 'publishing', reason: null };
      },
    );
  }

  /**
   * Pauses (`PAUSED`) or resumes (`ACTIVE`) every voucher of the batch that is on-chain, through
   * `updateVoucher`, so each one gets the checks and rules of pausing or resuming it alone (only an
   * Owner or an API key may pause; resuming needs no approval). Pausing takes ACTIVE vouchers, and
   * ones still publishing (they stay paused once live); resuming takes PAUSED ones already published.
   * Others are `skipped`. Archiving doesn't stop claims, so this works on an archived batch too.
   */
  async setVoucherBatchPaused(
    organizationId: string,
    batchId: string,
    paused: boolean,
    actor: VoucherActor,
    db: DrizzleDb = this.db,
  ) {
    return this.eachBatchVoucher(organizationId, batchId, db, null, async (tx, current) => {
      const applies = paused
        ? current.status === 'ACTIVE' || (current.status === 'DRAFT' && current.publishStatus === 'PUBLISHING')
        : current.status === 'PAUSED' && current.publishStatus === 'PUBLISHED';
      if (!applies) return { voucher: current, outcome: 'skipped', reason: null };
      const voucher = await this.updateVoucher(
        organizationId,
        current.id,
        { status: paused ? 'PAUSED' : 'ACTIVE' },
        () => undefined,
        tx,
        actor,
      );
      return { voucher, outcome: paused ? 'paused' : 'resumed', reason: null };
    });
  }

  /**
   * One-way. Marks the batch archived (hidden from the default list, can't be activated), then each of
   * its vouchers that never went live becomes `ARCHIVED`, so it can't be edited, submitted, approved
   * or claimed any more: a draft directly, and one waiting for approval once its request is withdrawn
   * ("Batch archived"; the reviewer is the user who archived it, `null` for an API key). Vouchers that
   * are publishing or live are `skipped`: archiving doesn't stop claims, pausing does. Re-importing an
   * archived voucher's code brings it back as a DRAFT. Archiving again only reports.
   */
  async archiveVoucherBatch(organizationId: string, batchId: string, actor: VoucherActor, db: DrizzleDb = this.db) {
    const reviewer = actor.role === 'CREDENTIAL' ? null : (actor.userId ?? null);
    return this.eachBatchVoucher(
      organizationId,
      batchId,
      db,
      null,
      async (tx, current) => {
        if (current.status === 'PENDING_APPROVAL') {
          await tx
            .update(voucherApprovalRequests)
            .set({ status: 'WITHDRAWN', reviewedById: reviewer, reviewedAt: new Date(), reason: 'Batch archived' })
            .where(
              and(eq(voucherApprovalRequests.voucherId, current.id), eq(voucherApprovalRequests.status, 'PENDING')),
            );
        } else if (!neverPublished(current)) {
          return { voucher: current, outcome: 'skipped', reason: null };
        }
        const [voucher] = await tx
          .update(vouchers)
          .set({ status: 'ARCHIVED', updatedAt: new Date() })
          .where(eq(vouchers.id, current.id))
          .returning();
        return { voucher, outcome: 'archived', reason: null };
      },
      async (tx, batch) => {
        if (batch.archivedAt) return batch;
        const [archived] = await tx
          .update(voucherImportBatches)
          .set({ archivedAt: new Date() })
          .where(eq(voucherImportBatches.id, batch.id))
          .returning();
        return archived;
      },
    );
  }

  private async lockBatch(tx: DrizzleDb, organizationId: string, batchId: string): Promise<VoucherBatch> {
    const [batch] = await tx
      .select()
      .from(voucherImportBatches)
      .where(and(eq(voucherImportBatches.id, batchId), eq(voucherImportBatches.organizationId, organizationId)))
      .for('update');
    if (!batch) throw notFound('Voucher batch not found');
    return batch;
  }

  /** Newest first; archived batches only when asked for. */
  async listVoucherBatches(organizationId: string, includeArchived: boolean, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx
        .select()
        .from(voucherImportBatches)
        .where(
          and(
            eq(voucherImportBatches.organizationId, organizationId),
            includeArchived ? undefined : isNull(voucherImportBatches.archivedAt),
          ),
        )
        .orderBy(desc(voucherImportBatches.createdAt)),
    );
  }

  /** Another organization's batch is not found. Its vouchers in `code` order. */
  async findVoucherBatch(organizationId: string, batchId: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, async (tx) => {
      const [batch] = await tx
        .select()
        .from(voucherImportBatches)
        .where(and(eq(voucherImportBatches.id, batchId), eq(voucherImportBatches.organizationId, organizationId)));
      if (!batch) return null;
      const members = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.organizationId, organizationId), eq(vouchers.importBatchId, batchId)))
        .orderBy(asc(vouchers.code));
      return { batch, vouchers: members };
    });
  }

  /** How many vouchers of each batch are in each status, by batch id. */
  async voucherBatchStatusCounts(
    organizationId: string,
    batchIds: string[],
    db: DrizzleDb = this.db,
  ): Promise<Map<string, Partial<Record<Voucher['status'], number>>>> {
    const counts = new Map<string, Partial<Record<Voucher['status'], number>>>();
    if (!batchIds.length) return counts;
    const rows = await withTenant(db, organizationId, (tx) =>
      tx
        .select({ batchId: vouchers.importBatchId, status: vouchers.status, total: count() })
        .from(vouchers)
        .where(and(eq(vouchers.organizationId, organizationId), inArray(vouchers.importBatchId, batchIds)))
        .groupBy(vouchers.importBatchId, vouchers.status),
    );
    for (const row of rows) {
      if (!row.batchId) continue;
      const entry = counts.get(row.batchId) ?? {};
      entry[row.status] = Number(row.total);
      counts.set(row.batchId, entry);
    }
    return counts;
  }
}
