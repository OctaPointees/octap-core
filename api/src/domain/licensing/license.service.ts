import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LICENSE_FEATURES,
  LICENSE_LIMIT_KEYS,
  LICENSE_TIERS,
  type CreateLicensePlanRequest,
  type LicenseEntitlements,
  type LicenseFeature,
  type LicenseLimits,
  type LicensePlanDto,
  type LicenseTier,
  type OrganizationLicenseDto,
  type UpdateLicensePlanRequest,
} from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import {
  LicensesRepository,
  type License,
  type LicensePlan,
  type LicensePlanPatch,
} from '#infra/db/repositories/licenses.repository.js';
import { daysLeft, graceEndsAt, licensePeriod, licenseState } from './license-state.js';

const MAX_NAME_LENGTH = 80;
const MAX_PRICE_VND = 2_000_000_000;
const MAX_TERM_MONTHS = 36;
const MAX_DURATION_DAYS = 3650;
const MAX_LIMIT = 2_000_000_000;

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * The organization's license and what it uses (OCT-329), and the plan catalogue the System Admin
 * manages. Reads only: limits are enforced in a later part of the ticket.
 */
@Injectable()
export class LicenseService {
  constructor(
    private readonly licenses: LicensesRepository,
    private readonly access: ConsoleOrganizationsRepository,
  ) {}

  /** The current license and its usage; `license: null` for an organization that never had one. */
  async read(organizationId: string, now = new Date()): Promise<OrganizationLicenseDto> {
    const license = await this.licenses.current(organizationId, now);
    if (!license) return { organizationId, license: null, usage: null };
    const period = licensePeriod(license.startsAt, license.endsAt, now);
    const counts = await this.licenses.usage(organizationId, period.start, period.end);
    return {
      organizationId,
      license: toLicenseDto(license, now),
      usage: {
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        transactionsMonthly: counts.transactions,
        members: counts.members,
        apiKeys: counts.apiKeys,
        teamMembers: counts.teamMembers,
      },
    };
  }

  /** For an active Owner or Business Developer of an active organization; anyone else gets 403. */
  /** For the System Admin: an organization that doesn't exist is a 404, not "no license". */
  async readForPlatform(organizationId: string): Promise<OrganizationLicenseDto> {
    if (!(await this.licenses.organizationExists(organizationId)))
      throw new NotFoundException('Organization not found');
    return this.read(organizationId);
  }

  async readAsMember(userId: string, organizationId: string): Promise<OrganizationLicenseDto> {
    try {
      await this.access.withAccess(userId, organizationId, false, async () => undefined);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Organization access is required');
      throw error;
    }
    return this.read(organizationId);
  }

  /** What an Owner can buy, cheapest first. */
  async listOffered(): Promise<LicensePlanDto[]> {
    return (await this.licenses.listPlans(true)).map(toPlanDto);
  }

  /** The whole catalogue, inactive and granted-only plans included. */
  async listAll(): Promise<LicensePlanDto[]> {
    return (await this.licenses.listPlans(false)).map(toPlanDto);
  }

  async createPlan(input: CreateLicensePlanRequest): Promise<LicensePlanDto> {
    const body = objectOf(input);
    if (!LICENSE_TIERS.includes(body.tier as LicenseTier))
      throw new BadRequestException(`tier must be one of ${LICENSE_TIERS.join(', ')}`);
    const values = checkPlanFields(body, ['tier']);
    const plan = {
      termMonthsAllowed: [],
      durationDays: null,
      purchasable: true,
      active: true,
      ...values,
    };
    checkSellable(plan);
    return toPlanDto(
      await this.licenses.createPlan({
        ...plan,
        tier: body.tier as LicenseTier,
        name: values.name!,
        monthlyPriceVnd: values.monthlyPriceVnd!,
        entitlements: values.entitlements!,
      }),
    );
  }

  /** Licenses already granted from this plan keep the entitlements they were given. */
  async updatePlan(id: string, input: UpdateLicensePlanRequest): Promise<LicensePlanDto> {
    const body = objectOf(input);
    if ('tier' in body) throw new BadRequestException("A plan's tier can't change; create another plan");
    const patch = checkPlanFields(body, []);
    if (!Object.keys(patch).length) throw new BadRequestException('Provide at least one field to change');
    const current = await this.licenses.findPlan(id);
    if (!current) throw new NotFoundException('License plan not found');
    checkSellable({ ...current, ...patch });
    return toPlanDto((await this.licenses.updatePlan(id, patch))!);
  }
}

function objectOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Body must be an object');
  return input as Record<string, unknown>;
}

const PLAN_FIELDS = [
  'name',
  'monthlyPriceVnd',
  'termMonthsAllowed',
  'durationDays',
  'entitlements',
  'purchasable',
  'active',
] as const;

/** Checks the plan fields present in `body`; anything else, apart from `allowed`, is refused. */
function checkPlanFields(body: Record<string, unknown>, allowed: string[]): LicensePlanPatch {
  const unknown = Object.keys(body).filter(
    (key) => !(PLAN_FIELDS as readonly string[]).includes(key) && !allowed.includes(key),
  );
  if (unknown.length) throw new BadRequestException(`Unknown field: ${unknown.join(', ')}`);
  const patch: LicensePlanPatch = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH)
      throw new BadRequestException(`name must be 1 to ${MAX_NAME_LENGTH} characters`);
    patch.name = name;
  }
  if (body.monthlyPriceVnd !== undefined) {
    if (!isWhole(body.monthlyPriceVnd, 0, MAX_PRICE_VND))
      throw new BadRequestException('monthlyPriceVnd must be a whole number of VND, 0 or more');
    patch.monthlyPriceVnd = body.monthlyPriceVnd;
  }
  if (body.termMonthsAllowed !== undefined) {
    const terms = body.termMonthsAllowed;
    if (
      !Array.isArray(terms) ||
      !terms.every((term) => isWhole(term, 1, MAX_TERM_MONTHS)) ||
      new Set(terms).size !== terms.length
    )
      throw new BadRequestException(`termMonthsAllowed must be distinct whole months from 1 to ${MAX_TERM_MONTHS}`);
    patch.termMonthsAllowed = [...(terms as number[])].sort((a, b) => a - b);
  }
  if (body.durationDays !== undefined) {
    if (body.durationDays !== null && !isWhole(body.durationDays, 1, MAX_DURATION_DAYS))
      throw new BadRequestException(
        `durationDays must be null or a whole number of days from 1 to ${MAX_DURATION_DAYS}`,
      );
    patch.durationDays = body.durationDays as number | null;
  }
  if (body.entitlements !== undefined) patch.entitlements = checkEntitlements(body.entitlements);
  for (const flag of ['purchasable', 'active'] as const) {
    if (body[flag] === undefined) continue;
    if (typeof body[flag] !== 'boolean') throw new BadRequestException(`${flag} must be true or false`);
    patch[flag] = body[flag] as boolean;
  }
  return patch;
}

/** Exactly the known features (each once) and every limit, each a positive whole number or null. */
export function checkEntitlements(value: unknown): LicenseEntitlements {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const features = body?.features;
  const limits = body?.limits;
  if (
    !Array.isArray(features) ||
    !features.every((feature) => LICENSE_FEATURES.includes(feature as LicenseFeature)) ||
    new Set(features).size !== features.length
  )
    throw new BadRequestException(
      `entitlements.features must list distinct features from: ${LICENSE_FEATURES.join(', ')}`,
    );
  if (!limits || typeof limits !== 'object' || Array.isArray(limits))
    throw new BadRequestException('entitlements.limits must be an object');
  const given = limits as Record<string, unknown>;
  const extra = Object.keys(given).filter((key) => !(LICENSE_LIMIT_KEYS as readonly string[]).includes(key));
  if (extra.length) throw new BadRequestException(`Unknown limit: ${extra.join(', ')}`);
  const checked = {} as LicenseLimits;
  for (const key of LICENSE_LIMIT_KEYS) {
    const limit = given[key];
    if (limit !== null && !isWhole(limit, 1, MAX_LIMIT))
      throw new BadRequestException(`entitlements.limits.${key} must be a positive whole number, or null for no limit`);
    checked[key] = limit as number | null;
  }
  return { features: features as LicenseFeature[], limits: checked };
}

/** An Owner can only buy a plan sold by the month. */
function checkSellable(plan: { purchasable?: boolean; termMonthsAllowed?: number[] }) {
  if (plan.purchasable && !plan.termMonthsAllowed?.length)
    throw new BadRequestException('A purchasable plan needs at least one term in termMonthsAllowed');
}

export function toPlanDto(plan: LicensePlan): LicensePlanDto {
  return {
    id: plan.id,
    tier: plan.tier,
    name: plan.name,
    monthlyPriceVnd: plan.monthlyPriceVnd,
    termMonthsAllowed: plan.termMonthsAllowed,
    durationDays: plan.durationDays,
    entitlements: plan.entitlements,
    purchasable: plan.purchasable,
    active: plan.active,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

function toLicenseDto(license: License, now: Date): NonNullable<OrganizationLicenseDto['license']> {
  return {
    id: license.id,
    organizationId: license.organizationId,
    planId: license.planId,
    tier: license.tier,
    planName: license.planName,
    entitlements: license.entitlements,
    source: license.source,
    startsAt: license.startsAt.toISOString(),
    endsAt: license.endsAt.toISOString(),
    graceEndsAt: graceEndsAt(license.endsAt).toISOString(),
    state: licenseState(license.endsAt, now),
    daysLeft: daysLeft(license.endsAt, now),
  };
}
