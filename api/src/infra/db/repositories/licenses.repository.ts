import type { LicenseFeature } from '@octap/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lte } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { licensePlans, licenses } from '../schema/licensing.schema.js';
import { organizationEndUsers } from '../schema/members.schema.js';
import { apiCredentials } from '../schema/organizations.schema.js';
import { organizationMemberships } from '../schema/auth.schema.js';
import { asOwnRole, withTenant } from '../rls.js';
import { licenseTransactionsUsed, requireLicenseFeature } from './license-enforcement.js';

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
   * Grants a license from `plan`, copying its entitlements as they are now. `db` joins the caller's
   * transaction, such as the one that approves the organization.
   */
  async grant(
    params: { organizationId: string; plan: LicensePlan; source: License['source']; startsAt: Date; endsAt: Date },
    db: DrizzleDb = this.db,
  ): Promise<License> {
    return withTenant(db, params.organizationId, async (tx) => {
      const [license] = await tx
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

  /**
   * What counts against the limits now. Transactions are this license month's counter (accepted
   * earns, redeems and paid voucher claims, less the ones that failed); the rest are counted as they
   * stand.
   */
  async usage(organizationId: string, license: Pick<License, 'id'>, periodStart: Date): Promise<LicenseUsageCounts> {
    return withTenant(this.db, organizationId, async (tx) => {
      // One connection per transaction: the queries run one after another.
      const [members] = await tx
        .select({ n: count() })
        .from(organizationEndUsers)
        .where(eq(organizationEndUsers.organizationId, organizationId));
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
  const [plan] = await tx
    .select()
    .from(licensePlans)
    .where(and(eq(licensePlans.tier, 'TRIAL'), eq(licensePlans.active, true)))
    .orderBy(asc(licensePlans.createdAt))
    .limit(1);
  if (!plan) return;
  const endsAt = new Date(now.getTime() + (plan.durationDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000);
  await withTenant(tx, organizationId, (inner) =>
    inner.insert(licenses).values({
      organizationId,
      planId: plan.id,
      tier: plan.tier,
      planName: plan.name,
      entitlements: plan.entitlements,
      source: 'TRIAL',
      startsAt: now,
      endsAt,
    }),
  );
}
