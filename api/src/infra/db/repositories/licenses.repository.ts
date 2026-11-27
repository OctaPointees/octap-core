import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { licensePlans, licenses } from '../schema/licensing.schema.js';
import { loyaltyTransactions } from '../schema/credits.schema.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';
import { organizationMemberships } from '../schema/auth.schema.js';
import { asOwnRole, withTenant } from '../rls.js';

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
   * What counts against the limits now. Transactions are the confirmed earns and redeems created in
   * `[from, to)`, the current license month; the rest are counted as they stand.
   */
  async usage(organizationId: string, from: Date, to: Date): Promise<LicenseUsageCounts> {
    return withTenant(this.db, organizationId, async (tx) => {
      // One connection per transaction: the queries run one after another.
      const [transactions] = await tx
        .select({ n: count() })
        .from(loyaltyTransactions)
        .where(
          and(
            eq(loyaltyTransactions.organizationId, organizationId),
            inArray(loyaltyTransactions.transactionType, ['EARN', 'REDEEM']),
            eq(loyaltyTransactions.status, 'CONFIRMED'),
            gte(loyaltyTransactions.createdAt, from),
            lt(loyaltyTransactions.createdAt, to),
          ),
        );
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
      return { transactions: transactions.n, members: members.n, apiKeys: apiKeys.n, teamMembers: team.n };
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
