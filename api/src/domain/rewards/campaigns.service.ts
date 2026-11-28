import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CAMPAIGN_MAX_DESCRIPTION_LENGTH,
  CAMPAIGN_MAX_MULTIPLIER_BPS,
  CAMPAIGN_MAX_NAME_LENGTH,
  type CampaignDetailDto,
  type CampaignDto,
  type CampaignVoucherActionResponse,
  type CreateCampaignRequest,
} from '@octap/contracts';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import {
  CampaignsRepository,
  type Campaign,
  type CampaignTransition,
} from '#infra/db/repositories/campaigns.repository.js';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import {
  RewardsRepository,
  type VoucherActor,
  type VoucherBatchActionRow,
} from '#infra/db/repositories/rewards.repository.js';
import { requireProgramConfig } from '../programs/program-config.js';
import { actorOf, bodyOf, seenOf } from './console-rewards.service.js';
import { toHttpError, toVoucherDto } from './rewards.service.js';

const READ_DENIED = 'Only an active Owner or Business Developer of an active organization can view its campaigns';
const WRITE_DENIED =
  'Only an active Owner or Business Developer of an active organization can create campaigns or change their vouchers';
const OWNER_DENIED =
  'Only an active Owner of an active organization can activate, pause, resume, end or archive a campaign';
const PAUSE_DENIED = 'Only an active Owner of an active organization can pause or resume its rewards';

/**
 * Campaigns from the console (OCT-340). The Owner and a Business Developer read them and create them
 * as DRAFTs. Only the Owner moves a campaign's own status: activating a DRAFT is its approval, and
 * nothing is boosted before it. An earn opts into a campaign with `campaignId`
 * (`campaign-boost.ts`); vouchers join one when they are created, alone or in a batch.
 *
 * The bulk voucher actions (`…/vouchers/activate|pause|resume|archive`) are the batch ones
 * (`RewardsRepository`'s shared loop) over the campaign's vouchers, with the same rules for who may
 * do what: a Business Developer's activation is a submission while approval is required, and only
 * the Owner pauses or resumes.
 */
@Injectable()
export class ConsoleCampaignsService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly campaigns: CampaignsRepository,
    private readonly rewardsRepo: RewardsRepository,
    private readonly programsRepo: ProgramsRepository,
  ) {}

  private async run<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(message);
      throw toHttpError(error);
    }
  }

  list(userId: string, orgId: string, includeArchived?: unknown): Promise<CampaignDto[]> {
    const archived = parseFlag(includeArchived);
    return this.run(READ_DENIED, async () => {
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      return (await this.campaigns.list(orgId, archived)).map((c) => toCampaignDto(c));
    });
  }

  /** The campaign's earn rule and its vouchers, on one screen. Another organization's is a 404. */
  detail(userId: string, orgId: string, campaignId: string): Promise<CampaignDetailDto> {
    return this.run(READ_DENIED, async () => {
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      const campaign = await this.campaigns.find(orgId, campaignId);
      if (!campaign) throw new NotFoundException('Campaign not found');
      await this.rewardsRepo.expireDueFor(orgId, { memberVouchers: 'none' });
      const vouchers = await this.rewardsRepo.listCampaignVouchers(orgId, campaignId);
      const approvals = await this.rewardsRepo.latestApprovals(
        orgId,
        vouchers.map((v) => v.id),
      );
      return {
        ...toCampaignDto(campaign),
        vouchers: vouchers.map((v) => toVoucherDto(v, approvals.get(v.id) ?? null)),
      };
    });
  }

  create(userId: string, orgId: string, body: unknown): Promise<CampaignDto> {
    const values = parseCreate(body);
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, async (tx) =>
        toCampaignDto(await this.campaigns.create(orgId, values, userId, tx)),
      ),
    );
  }

  transition(userId: string, orgId: string, campaignId: string, transition: CampaignTransition): Promise<CampaignDto> {
    return this.run(OWNER_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, async (tx) =>
        toCampaignDto(await this.campaigns.transition(orgId, campaignId, transition, userId, tx)),
      ),
    );
  }

  /** `seen`, as for a batch (OCT-324): the vouchers as the Owner reviewed them. */
  activateVouchers(
    userId: string,
    orgId: string,
    campaignId: string,
    input?: { seen?: unknown } | null,
  ): Promise<CampaignVoucherActionResponse> {
    const body = bodyOf(input);
    if (Object.keys(body).some((key) => key !== 'seen')) throw new BadRequestException('Only seen may be sent');
    const seen = body.seen === undefined ? null : seenOf(body.seen);
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, async (tx, role) => {
        await requireProgramConfig(
          { findByOrganization: (id: string) => this.programsRepo.findByOrganization(id, tx) },
          orgId,
        );
        const results = await this.rewardsRepo.activateCampaignVouchers(
          orgId,
          campaignId,
          actorOf(userId, role),
          tx,
          seen,
        );
        return this.actionResponse(orgId, campaignId, results, tx);
      }),
    );
  }

  /** Only the Owner pauses or resumes, as for a single voucher or a batch. */
  setVouchersPaused(
    userId: string,
    orgId: string,
    campaignId: string,
    paused: boolean,
  ): Promise<CampaignVoucherActionResponse> {
    return this.run(PAUSE_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, async (tx) => {
        const actor: VoucherActor = actorOf(userId, 'OWNER');
        const results = await this.rewardsRepo.setCampaignVouchersPaused(orgId, campaignId, paused, actor, tx);
        return this.actionResponse(orgId, campaignId, results, tx);
      }),
    );
  }

  archiveVouchers(userId: string, orgId: string, campaignId: string): Promise<CampaignVoucherActionResponse> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, async (tx, role) => {
        const results = await this.rewardsRepo.archiveCampaignVouchers(orgId, campaignId, actorOf(userId, role), tx);
        return this.actionResponse(orgId, campaignId, results, tx);
      }),
    );
  }

  private async actionResponse(
    orgId: string,
    campaignId: string,
    results: VoucherBatchActionRow[],
    tx: DrizzleDb,
  ): Promise<CampaignVoucherActionResponse> {
    const campaign = await this.campaigns.find(orgId, campaignId, tx);
    return {
      campaign: toCampaignDto(campaign!),
      vouchers: results.map(({ voucher, outcome, reason }) => ({
        voucherId: voucher.id,
        code: voucher.code,
        outcome,
        status: voucher.status,
        reason,
      })),
    };
  }
}

export function toCampaignDto(campaign: Campaign, now: Date = new Date()): CampaignDto {
  return {
    id: campaign.id,
    organizationId: campaign.organizationId,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    multiplierBps: campaign.multiplierBps,
    earnBoostLive:
      campaign.status === 'ACTIVE' &&
      campaign.multiplierBps !== null &&
      campaign.startsAt <= now &&
      now <= campaign.endsAt,
    createdByUserId: campaign.createdByUserId,
    approvedByUserId: campaign.approvedByUserId,
    approvedAt: campaign.approvedAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

const CREATE_FIELDS = new Set(['name', 'description', 'startsAt', 'endsAt', 'multiplierBps']);

/** A `CreateCampaignRequest`, checked field by field; any problem is a 400. */
export function parseCreate(
  body: unknown,
): Pick<Campaign, 'name' | 'description' | 'startsAt' | 'endsAt' | 'multiplierBps'> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Campaign body must be an object');
  const input = body as Partial<Record<keyof CreateCampaignRequest, unknown>>;
  if (Object.keys(input).some((key) => !CREATE_FIELDS.has(key)))
    throw new BadRequestException('Campaign body contains unsupported fields');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > CAMPAIGN_MAX_NAME_LENGTH)
    throw new BadRequestException(`name must be a nonempty string of at most ${CAMPAIGN_MAX_NAME_LENGTH} characters`);
  const description = input.description ?? null;
  if (description !== null && (typeof description !== 'string' || description.length > CAMPAIGN_MAX_DESCRIPTION_LENGTH))
    throw new BadRequestException(
      `description must be a string of at most ${CAMPAIGN_MAX_DESCRIPTION_LENGTH} characters`,
    );
  const startsAt = isoDate(input.startsAt, 'startsAt');
  const endsAt = isoDate(input.endsAt, 'endsAt');
  if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
  const multiplierBps = input.multiplierBps ?? null;
  if (
    multiplierBps !== null &&
    (typeof multiplierBps !== 'number' ||
      !Number.isInteger(multiplierBps) ||
      multiplierBps <= 10_000 ||
      multiplierBps > CAMPAIGN_MAX_MULTIPLIER_BPS)
  )
    throw new BadRequestException(
      `multiplierBps must be a whole number above 10000 (1x) and at most ${CAMPAIGN_MAX_MULTIPLIER_BPS} (10x), or null`,
    );
  return {
    name,
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    startsAt,
    endsAt,
    multiplierBps,
  };
}

function isoDate(value: unknown, field: string): Date {
  const at = typeof value === 'string' ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) throw new BadRequestException(`${field} must be an ISO 8601 timestamp`);
  return at;
}

/** `?includeArchived=true` arrives as a string; a boolean is fine too. */
function parseFlag(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BadRequestException('includeArchived must be true or false');
}
