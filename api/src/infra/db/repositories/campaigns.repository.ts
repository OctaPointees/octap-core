import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { withTenant } from '../rls.js';
import { campaigns } from '../schema/campaigns.schema.js';
import { recordAudit } from './audit.repository.js';
import { RewardsRuleError } from './rewards.repository.js';
import { outsideRequestContext, SYSTEM_ACTOR } from '#observability/request-context.js';

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignStatus = Campaign['status'];
/** What an Owner can do to a campaign's own status. */
export type CampaignTransition = 'activate' | 'pause' | 'resume' | 'end' | 'archive';

/** From which statuses each transition starts, and where it goes. */
const TRANSITIONS: Record<CampaignTransition, { from: CampaignStatus[]; to: CampaignStatus; audit: string }> = {
  activate: { from: ['DRAFT'], to: 'ACTIVE', audit: 'campaign.activated' },
  pause: { from: ['ACTIVE'], to: 'PAUSED', audit: 'campaign.paused' },
  resume: { from: ['PAUSED'], to: 'ACTIVE', audit: 'campaign.resumed' },
  end: { from: ['ACTIVE', 'PAUSED'], to: 'ENDED', audit: 'campaign.ended' },
  archive: { from: ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'], to: 'ARCHIVED', audit: 'campaign.archived' },
};

/** Campaigns one close pass ends in a transaction. */
export const CAMPAIGN_CLOSE_BATCH_SIZE = 500;
/** The statuses a campaign leaves for ENDED once its window has passed. */
const CLOSABLE_STATUSES: CampaignStatus[] = ['ACTIVE', 'PAUSED'];

/**
 * Ends up to `limit` ACTIVE or PAUSED campaigns whose `endsAt` is before `now` (OCT-343), each with
 * a `campaign.ended` audit row from the system, so the stored status never says ACTIVE for a
 * campaign that boosts nothing any more. An earn at exactly `endsAt` is still boosted, so only a
 * window that is strictly over closes. Rows another transaction holds (an Owner's transition, an
 * earn's share lock) are skipped and picked up next time, and the update repeats the status
 * condition, so two passes at once end each campaign and write its audit row once.
 */
async function closeDueCampaigns(
  tx: DrizzleDb,
  options: { limit: number; now: Date; organizationId?: string },
): Promise<number> {
  const due = await tx
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(
      and(
        inArray(campaigns.status, CLOSABLE_STATUSES),
        lt(campaigns.endsAt, options.now),
        options.organizationId ? eq(campaigns.organizationId, options.organizationId) : undefined,
      ),
    )
    .orderBy(asc(campaigns.endsAt))
    .limit(options.limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return 0;
  const before = new Map(due.map((row) => [row.id, row.status]));
  const ended = await tx
    .update(campaigns)
    .set({ status: 'ENDED', updatedAt: options.now })
    .where(and(inArray(campaigns.id, [...before.keys()]), inArray(campaigns.status, CLOSABLE_STATUSES)))
    .returning();
  for (const campaign of ended) {
    await recordAudit(tx, {
      organizationId: campaign.organizationId,
      action: 'campaign.ended',
      targetType: 'campaign',
      targetId: campaign.id,
      changes: { status: { from: before.get(campaign.id), to: 'ENDED' }, reason: 'window_ended' },
      actor: SYSTEM_ACTOR,
    });
  }
  return ended.length;
}

/**
 * Campaigns (OCT-340), always under the organization's RLS context (`withTenant`). Rule errors are
 * `RewardsRuleError`s, mapped to HTTP statuses like a voucher's.
 */
@Injectable()
export class CampaignsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async create(
    organizationId: string,
    values: Pick<Campaign, 'name' | 'description' | 'startsAt' | 'endsAt' | 'multiplierBps'>,
    createdByUserId: string,
    db: DrizzleDb = this.db,
  ): Promise<Campaign> {
    return withTenant(db, organizationId, async (tx) => {
      const [campaign] = await tx
        .insert(campaigns)
        .values({ ...values, organizationId, createdByUserId })
        .returning();
      await recordAudit(tx, {
        organizationId,
        action: 'campaign.created',
        targetType: 'campaign',
        targetId: campaign.id,
        // The terms, which never change after creation: with the activation row (who approved it,
        // and when) the sealed audit log (OCT-77) proves what each boosted earn on-chain was matched to.
        changes: {
          name: campaign.name,
          startsAt: campaign.startsAt.toISOString(),
          endsAt: campaign.endsAt.toISOString(),
          multiplierBps: campaign.multiplierBps,
        },
      });
      return campaign;
    });
  }

  /**
   * One sweep pass over every organization (`CampaignCloseWorker`): ends up to `limit` campaigns
   * whose window is over, and returns how many.
   */
  async closeDue(limit = CAMPAIGN_CLOSE_BATCH_SIZE, now = new Date()): Promise<number> {
    return this.db.transaction((tx) => closeDueCampaigns(tx, { limit, now }));
  }

  /**
   * Ends this organization's campaigns whose window is over before a read returns them, so a read
   * never shows ACTIVE or PAUSED for one that has ended, whenever the sweep last ran. It is the
   * system's change, not the reader's: it runs outside the request context.
   */
  async closeDueFor(organizationId: string, db: DrizzleDb = this.db): Promise<void> {
    await outsideRequestContext(() =>
      withTenant(db, organizationId, async (tx) => {
        const now = new Date();
        while (
          (await closeDueCampaigns(tx, { limit: CAMPAIGN_CLOSE_BATCH_SIZE, now, organizationId })) ===
          CAMPAIGN_CLOSE_BATCH_SIZE
        );
      }),
    );
  }

  /** Newest first; archived ones only when asked for. */
  async list(organizationId: string, includeArchived: boolean, db: DrizzleDb = this.db): Promise<Campaign[]> {
    return withTenant(db, organizationId, (tx) =>
      tx
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.organizationId, organizationId),
            includeArchived ? undefined : ne(campaigns.status, 'ARCHIVED'),
          ),
        )
        .orderBy(desc(campaigns.createdAt), desc(campaigns.id)),
    );
  }

  /** Another organization's campaign is not found. */
  async find(organizationId: string, id: string, db: DrizzleDb = this.db): Promise<Campaign | undefined> {
    return withTenant(db, organizationId, async (tx) => {
      const [campaign] = await tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id)));
      return campaign;
    });
  }

  /**
   * Moves the campaign along `TRANSITIONS` under its row lock. Activating or resuming one whose window
   * is already over is refused: it could never boost anything. The first activation records the
   * approving Owner.
   */
  async transition(
    organizationId: string,
    id: string,
    transition: CampaignTransition,
    userId: string,
    db: DrizzleDb = this.db,
  ): Promise<Campaign> {
    return withTenant(db, organizationId, async (tx) => {
      const current = await this.lock(tx, organizationId, id, 'update');
      const rule = TRANSITIONS[transition];
      if (!rule.from.includes(current.status))
        throw new RewardsRuleError('CONFLICT', `A ${current.status} campaign cannot ${transition}`);
      const now = new Date();
      if (rule.to === 'ACTIVE' && current.endsAt <= now)
        throw new RewardsRuleError('CONFLICT', 'This campaign has already ended; end or archive it instead');
      // Pausing one whose window is over would only hold it until the sweep ends it.
      if (transition === 'pause' && current.endsAt < now)
        throw new RewardsRuleError('CONFLICT', 'This campaign has already ended; end or archive it instead');
      const [updated] = await tx
        .update(campaigns)
        .set({
          status: rule.to,
          updatedAt: now,
          ...(transition === 'activate' && !current.approvedAt ? { approvedByUserId: userId, approvedAt: now } : {}),
        })
        .where(eq(campaigns.id, id))
        .returning();
      await recordAudit(tx, {
        organizationId,
        action: rule.audit,
        targetType: 'campaign',
        targetId: id,
        changes: { status: { from: current.status, to: rule.to } },
      });
      return updated;
    });
  }

  /**
   * The campaign under a share lock, inside the caller's transaction, or undefined. An earn re-checks
   * its campaign this way, so a pause or end (which takes the row lock) waits for that earn to commit,
   * or the earn sees the new status.
   */
  async findLocked(tx: DrizzleDb, organizationId: string, id: string): Promise<Campaign | undefined> {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id)))
      .for('share');
    return campaign;
  }

  /** The campaign row, locked; call it inside the organization's `withTenant` block. */
  async lock(tx: DrizzleDb, organizationId: string, id: string, mode: 'update' | 'share'): Promise<Campaign> {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id)))
      .for(mode);
    if (!campaign) throw new RewardsRuleError('NOT_FOUND', 'Campaign not found');
    return campaign;
  }
}
