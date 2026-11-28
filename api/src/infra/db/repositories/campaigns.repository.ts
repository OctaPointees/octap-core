import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { withTenant } from '../rls.js';
import { campaigns } from '../schema/campaigns.schema.js';
import { recordAudit } from './audit.repository.js';
import { RewardsRuleError } from './rewards.repository.js';

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
      });
      return campaign;
    });
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
