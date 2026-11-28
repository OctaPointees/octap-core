import { LICENSE_EXPIRY_REMINDER_DAYS, type LicenseExpiryNoticeEventData, type LicenseFeature } from '@octap/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, ne, notExists, or } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { licensePlans, licenses } from '../schema/licensing.schema.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';
import { organizationMemberships } from '../schema/auth.schema.js';
import { asOwnRole, withTenant } from '../rls.js';
import { licenseTransactionsUsed, requireLicenseFeature } from './license-enforcement.js';
import { recordEvent } from './events.repository.js';
import { addMonths, daysLeft, graceEndsAt, licenseExpiryStage, renewalStart } from './license-period.js';

/** A second reference to `licenses`, for "a later license of the same organization". */
const later = alias(licenses, 'later');

export type LicensePlan = typeof licensePlans.$inferSelect;
export type License = typeof licenses.$inferSelect;
export type NewLicensePlan = typeof licensePlans.$inferInsert;
export type LicensePlanPatch = Partial<
  Pick<
    NewLicensePlan,
    'name' | 'monthlyPriceVnd' | 'termMonthsAllowed' | 'durationDays' | 'entitlements' | 'purchasable' | 'active'
  >
>;

/** The counts behind a license's limits, for one organization. */
export interface LicenseUsageCounts {
  transactions: number;
  members: number;
  apiKeys: number;
  teamMembers: number;
}

/**
 * Licenses and the plan catalogue (OCT-329). Plans are platform data, read and written without a
 * tenant. A license is tenant data: it is read and written under its organization's RLS context.
 */
@Injectable()
export class LicensesRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** 402 unless the organization's license includes `feature`; nothing is enforced without one. */
  requireFeature(organizationId: string, feature: LicenseFeature): Promise<void> {
    return requireLicenseFeature(this.db, organizationId, feature);
  }

  /** The whole catalogue, or only what an Owner may buy (active and purchasable). */
  listPlans(offeredOnly: boolean): Promise<LicensePlan[]> {
    return this.db
      .select()
      .from(licensePlans)
      .where(offeredOnly ? and(eq(licensePlans.active, true), eq(licensePlans.purchasable, true)) : undefined)
      .orderBy(asc(licensePlans.monthlyPriceVnd), asc(licensePlans.createdAt));
  }

  async findPlan(id: string): Promise<LicensePlan | undefined> {
    const [plan] = await this.db.select().from(licensePlans).where(eq(licensePlans.id, id));
    return plan;
  }

  async createPlan(values: NewLicensePlan): Promise<LicensePlan> {
    const [plan] = await this.db.insert(licensePlans).values(values).returning();
    return plan;
  }

  /** Licenses already granted keep their own copy of the entitlements. */
  async updatePlan(id: string, patch: LicensePlanPatch): Promise<LicensePlan | undefined> {
    const [plan] = await this.db
      .update(licensePlans)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(licensePlans.id, id))
      .returning();
    return plan;
  }

  /**
   * The license in force at `at`: the latest one that has started, expired or not (an expired one
   * still says what the organization had). `undefined` when it never had one.
   */
  /** Whether the organization exists, whatever its status. Read as the connection owner. */
  async organizationExists(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row !== undefined;
  }

  async current(organizationId: string, at: Date, db: DrizzleDb = this.db): Promise<License | undefined> {
    return withTenant(db, organizationId, async (tx) => {
      const [license] = await tx
        .select()
        .from(licenses)
        .where(and(eq(licenses.organizationId, organizationId), lte(licenses.startsAt, at)))
        .orderBy(desc(licenses.startsAt), desc(licenses.createdAt))
        .limit(1);
      return license;
    });
  }

  /**
  /**
   * Grants `months` of `plan` after the organization's latest license (OCT-329 part 3): from its
   * `endsAt` while it is active or in grace, so renewing early or late loses no day, and from `now`
   * once it has expired or when there is none. The organization row is locked first, so two renewals
   * at once queue up and the second follows the first instead of overlapping it. `undefined` when
   * the organization doesn't exist.
   */
  async renew(params: {
    organizationId: string;
    plan: LicensePlan;
    months: number;
    source: License['source'];
    now?: Date;
  }): Promise<License | undefined> {
    const now = params.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, params.organizationId))
        .for('update');
      if (!organization) return undefined;
      const latest = await withTenant(tx, params.organizationId, async (inner) => {
        const [row] = await inner
          .select()
          .from(licenses)
          .where(eq(licenses.organizationId, params.organizationId))
          .orderBy(desc(licenses.startsAt), desc(licenses.createdAt))
          .limit(1);
        return row;
      });
      const startsAt = renewalStart(latest, now);
      return insertLicense(tx, {
        organizationId: params.organizationId,
        plan: params.plan,
        source: params.source,
        startsAt,
        endsAt: addMonths(startsAt, params.months),
      });
    });
  }

  /**
   * One pass of the expiry notices (`LicenseExpiryWorker`), across every organization: an RLS
   * exception, like the outbox trim. For each organization's latest license that is within 30 days
   * of its end, records `license.expiry_notice` for the step it has reached (see
   * `licenseExpiryStage`), if that step is past the one already sent. The step moves forward with a
   * conditional update in the same transaction as the event, so a step is sent once, even with
   * several workers. A license that was renewed (a later one exists) sends nothing more, and when
   * steps passed unseen only the current one is sent. Returns how many notices were recorded.
   */
  async recordExpiryNotices(now = new Date(), pageSize = 200): Promise<number> {
    const horizon = new Date(now.getTime() + LICENSE_EXPIRY_REMINDER_DAYS[0] * 24 * 60 * 60 * 1000);
    let sent = 0;
    let after: { endsAt: Date; id: string } | undefined;
    for (;;) {
      const page = await this.db
        .select({ license: licenses })
        .from(licenses)
        .innerJoin(organizations, eq(organizations.id, licenses.organizationId))
        .where(
          and(
            ne(organizations.status, 'ARCHIVED'),
            lte(licenses.endsAt, horizon),
            or(isNull(licenses.expiryNoticeStage), ne(licenses.expiryNoticeStage, 'EXPIRED')),
            notExists(
              this.db
                .select({ id: later.id })
                .from(later)
                .where(
                  and(
                    eq(later.organizationId, licenses.organizationId),
                    or(
                      gt(later.startsAt, licenses.startsAt),
                      and(eq(later.startsAt, licenses.startsAt), gt(later.createdAt, licenses.createdAt)),
                    ),
                  ),
                ),
            ),
            after
              ? or(gt(licenses.endsAt, after.endsAt), and(eq(licenses.endsAt, after.endsAt), gt(licenses.id, after.id)))
              : undefined,
          ),
        )
        .orderBy(asc(licenses.endsAt), asc(licenses.id))
        .limit(pageSize);
      for (const { license } of page) {
        const stage = licenseExpiryStage(license.startsAt, license.endsAt, now);
        if (!stage) continue;
        const recorded = await this.db.transaction(async (tx) => {
          // Enum order is the step order, so `<` means "an earlier step".
          const [moved] = await tx
            .update(licenses)
            .set({ expiryNoticeStage: stage })
            .where(
              and(
                eq(licenses.id, license.id),
                or(isNull(licenses.expiryNoticeStage), lt(licenses.expiryNoticeStage, stage)),
              ),
            )
            .returning({ id: licenses.id });
          if (!moved) return false;
          const payload: LicenseExpiryNoticeEventData = {
            licenseId: license.id,
            stage,
            tier: license.tier,
            planName: license.planName,
            endsAt: license.endsAt.toISOString(),
            graceEndsAt: graceEndsAt(license.endsAt).toISOString(),
            daysLeft: daysLeft(license.endsAt, now),
          };
          await recordEvent(tx, { organizationId: license.organizationId, type: 'license.expiry_notice', payload });
          return true;
        });
        if (recorded) sent += 1;
      }
      if (page.length < pageSize) return sent;
      const last = page[page.length - 1].license;
      after = { endsAt: last.endsAt, id: last.id };
    }
  }

  /**
   * What counts against the limits now. Transactions are this license month's counter (accepted
   * earns, redeems and paid voucher claims, less the ones that failed); the rest are counted as they
   * stand.
   */
  async usage(organizationId: string, license: Pick<License, 'id'>, periodStart: Date): Promise<LicenseUsageCounts> {
    return withTenant(this.db, organizationId, async (tx) => {
      // One connection per transaction: the queries run one after another.
      // Only members who can take part: active here and not blocked or unverified globally, the same
      // test as `member-eligibility`. The global status isn't visible under a tenant, so this is read
      // as the connection's own role, still for this organization only.
      const [members] = await asOwnRole(tx, (own) =>
        own
          .select({ n: count() })
          .from(organizationEndUsers)
          .innerJoin(endUsers, eq(endUsers.id, organizationEndUsers.endUserId))
          .where(
            and(
              eq(organizationEndUsers.organizationId, organizationId),
              eq(organizationEndUsers.status, 'ACTIVE'),
              eq(endUsers.status, 'ACTIVE'),
            ),
          ),
      );
      const [apiKeys] = await tx
        .select({ n: count() })
        .from(apiCredentials)
        .where(and(eq(apiCredentials.organizationId, organizationId), eq(apiCredentials.status, 'ACTIVE')));
      // Memberships are only visible to their own user under RLS, so the team is counted as the
      // connection's own role, still for this organization only.
      const [team] = await asOwnRole(tx, (own) =>
        own
          .select({ n: count() })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, organizationId),
              eq(organizationMemberships.status, 'ACTIVE'),
              inArray(organizationMemberships.role, ['OWNER', 'BUSINESS_DEVELOPER']),
            ),
          ),
      );
      return {
        transactions: await licenseTransactionsUsed(tx, organizationId, license, periodStart),
        members: members.n,
        apiKeys: apiKeys.n,
        teamMembers: team.n,
      };
    });
  }
}

/** How long the trial lasts when its plan doesn't say. */
const DEFAULT_TRIAL_DAYS = 14;

/**
 * Grants the trial to an organization that was just approved, in the approval's transaction, so an
 * approved organization always has a license (OCT-329). Nothing is granted while the catalogue has
 * no active trial plan: the System Admin grants a license by hand then.
 */
export async function grantTrialLicense(tx: DrizzleDb, organizationId: string, now = new Date()): Promise<void> {
  // An organization that already has a license (one migrated in, or granted by hand) keeps it: a
  // trial started now would be the latest license and replace it.
  const [existing] = await withTenant(tx, organizationId, (inner) =>
    inner.select({ id: licenses.id }).from(licenses).where(eq(licenses.organizationId, organizationId)).limit(1),
  );
  if (existing) return;
  // The newest active trial plan, so one the System Admin adds takes over from the old one.
  const [plan] = await tx
    .select()
    .from(licensePlans)
    .where(and(eq(licensePlans.tier, 'TRIAL'), eq(licensePlans.active, true)))
    .orderBy(desc(licensePlans.createdAt))
    .limit(1);
  if (!plan) return;
  const endsAt = new Date(now.getTime() + (plan.durationDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000);
  await insertLicense(tx, { organizationId, plan, source: 'TRIAL', startsAt: now, endsAt });
}

/**
 * The one way a license is written: from `plan`, copying its entitlements as they are now, so later
 * edits to the plan never change it. Joins the caller's transaction, under the organization's tenant.
 */
export async function insertLicense(
  tx: DrizzleDb,
  params: { organizationId: string; plan: LicensePlan; source: License['source']; startsAt: Date; endsAt: Date },
): Promise<License> {
  return withTenant(tx, params.organizationId, async (inner) => {
    const [license] = await inner
      .insert(licenses)
      .values({
        organizationId: params.organizationId,
        planId: params.plan.id,
        tier: params.plan.tier,
        planName: params.plan.name,
        entitlements: params.plan.entitlements,
        source: params.source,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
      })
      .returning();
    return license;
  });
}
