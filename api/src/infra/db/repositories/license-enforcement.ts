import { HttpException } from '@nestjs/common';
import { and, desc, eq, gt, lte, sql, isNull } from 'drizzle-orm';
import {
  LICENSE_TRANSACTION_HARD_LIMIT_PERCENT,
  LICENSE_USAGE_THRESHOLDS,
  type LicenseErrorBody,
  type LicenseFeature,
  type LicenseLimits,
} from '@octap/contracts';
import type { DrizzleDb } from '../postgres.provider.js';
import { licenses, licenseUsage } from '../schema/licensing.schema.js';
import { withTenant } from '../rls.js';
import { recordEvent } from './events.repository.js';
import { licensePeriod } from './license-period.js';

type License = typeof licenses.$inferSelect;

/**
 * A request the organization's license doesn't allow (OCT-329): a feature it doesn't include, or a
 * limit it has used up. Always 402, with a body that says which, so the console and SDKs can offer
 * an upgrade instead of an error.
 */
export class LicenseLimitError extends HttpException {
  constructor(body: Omit<LicenseErrorBody, 'statusCode'>) {
    super({ statusCode: 402, ...body }, 402);
  }
}

/** The new transactions a license month allows: 110% of the plan's limit. */
export const transactionHardLimit = (limit: number): number =>
  Math.floor((limit * LICENSE_TRANSACTION_HARD_LIMIT_PERCENT) / 100);

/**
 * The license in force at `at` (the latest that has started), read in the caller's transaction.
 * `undefined` when the organization never had one: nothing is enforced then.
 */
export async function licenseInForce(tx: DrizzleDb, organizationId: string, at: Date): Promise<License | undefined> {
  return withTenant(tx, organizationId, async (inner) => {
    const [license] = await inner
      .select()
      .from(licenses)
      .where(and(eq(licenses.organizationId, organizationId), lte(licenses.startsAt, at)))
      .orderBy(desc(licenses.startsAt), desc(licenses.createdAt))
      .limit(1);
    return license;
  });
}

/** Refuses with 402 unless the license in force includes `feature`. No license: allowed. */
export async function requireLicenseFeature(
  tx: DrizzleDb,
  organizationId: string,
  feature: LicenseFeature,
  now = new Date(),
): Promise<void> {
  const license = await licenseInForce(tx, organizationId, now);
  if (!license || license.entitlements.features.includes(feature)) return;
  throw new LicenseLimitError({
    code: 'LICENSE_FEATURE_NOT_INCLUDED',
    feature,
    message: `The ${license.planName} license doesn't include ${feature}. Upgrade the license to use it.`,
  });
}

const RESOURCE_NAMES: Record<Exclude<keyof LicenseLimits, 'transactionsMonthly'>, string> = {
  members: 'members',
  apiKeys: 'active API keys',
  teamMembers: 'Owners and Business Developers',
};

/**
 * Refuses with 402 when adding one more `limit` would go past the license. It locks the license row
 * (FOR UPDATE) before `countInUse` runs, so two adds racing for the last place queue up instead of
 * both getting it. No license, or no limit: allowed. Call it in the transaction that adds.
 */
export async function requireLicenseCapacity(
  tx: DrizzleDb,
  organizationId: string,
  limit: Exclude<keyof LicenseLimits, 'transactionsMonthly'>,
  countInUse: () => Promise<number>,
  now = new Date(),
): Promise<void> {
  const license = await withTenant(tx, organizationId, async (inner) => {
    const [row] = await inner
      .select()
      .from(licenses)
      .where(and(eq(licenses.organizationId, organizationId), lte(licenses.startsAt, now)))
      .orderBy(desc(licenses.startsAt), desc(licenses.createdAt))
      .limit(1)
      .for('update');
    return row;
  });
  const allowed = license?.entitlements.limits[limit];
  if (!license || allowed === null || allowed === undefined) return;
  const inUse = await countInUse();
  if (inUse < allowed) return;
  throw new LicenseLimitError({
    code: 'LICENSE_LIMIT_REACHED',
    limit,
    used: inUse,
    allowed,
    message: `The ${license.planName} license allows ${allowed} ${RESOURCE_NAMES[limit]}, and all of them are in use. Upgrade the license to add more.`,
  });
}

/**
 * Counts one accepted transaction (an earn, a POS redeem or a paid voucher claim) against the
 * license month, in the caller's transaction, so a rollback gives it back. One conditional update
 * takes it only below 110% of the limit: concurrent accepts queue on the counter's row and can't
 * overshoot. Crossing 80% or 100% records `license.usage_threshold`, once each per month. Call it at
 * the end of the accept, to hold the counter's row as briefly as possible.
 */
export async function takeLicenseTransaction(tx: DrizzleDb, organizationId: string, now = new Date()): Promise<void> {
  const license = await licenseInForce(tx, organizationId, now);
  if (!license) return;
  const limit = license.entitlements.limits.transactionsMonthly;
  const period = licensePeriod(license.startsAt, now);
  await withTenant(tx, organizationId, async (inner) => {
    await inner
      .insert(licenseUsage)
      .values({ organizationId, licenseId: license.id, periodStart: period.start, periodEnd: period.end })
      .onConflictDoNothing({ target: [licenseUsage.licenseId, licenseUsage.periodStart] });
    const where = and(eq(licenseUsage.licenseId, license.id), eq(licenseUsage.periodStart, period.start));
    const hardLimit = limit === null ? null : transactionHardLimit(limit);
    const [taken] = await inner
      .update(licenseUsage)
      .set({ transactions: sql`${licenseUsage.transactions} + 1`, updatedAt: now })
      .where(hardLimit === null ? where : and(where, sql`${licenseUsage.transactions} < ${hardLimit}`))
      .returning({ transactions: licenseUsage.transactions });
    if (!taken) {
      throw new LicenseLimitError({
        code: 'LICENSE_LIMIT_REACHED',
        limit: 'transactionsMonthly',
        used: hardLimit!,
        allowed: hardLimit!,
        message: `This organization has used the ${limit} transactions its ${license.planName} license allows this month, and the 10% beyond. Upgrade or renew the license to accept more.`,
      });
    }
    if (limit === null) return;
    for (const threshold of LICENSE_USAGE_THRESHOLDS) {
      if (taken.transactions < Math.ceil((limit * threshold) / 100)) continue;
      const column = threshold === 80 ? licenseUsage.warned80At : licenseUsage.warned100At;
      const [first] = await inner
        .update(licenseUsage)
        .set(threshold === 80 ? { warned80At: now } : { warned100At: now })
        .where(and(where, isNull(column)))
        .returning({ id: licenseUsage.id });
      if (!first) continue;
      await recordEvent(inner, {
        organizationId,
        type: 'license.usage_threshold',
        payload: {
          limit: 'transactionsMonthly',
          threshold,
          used: taken.transactions,
          allowed: limit,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
        },
      });
    }
  });
}

/**
 * Gives back the count of a transaction that ended FAILED, in the license month it was accepted in
 * (`acceptedAt` is its `created_at`). A month that counted nothing is left alone.
 */
export async function releaseLicenseTransaction(
  tx: DrizzleDb,
  organizationId: string,
  acceptedAt: Date,
): Promise<void> {
  const license = await licenseInForce(tx, organizationId, acceptedAt);
  if (!license) return;
  const period = licensePeriod(license.startsAt, acceptedAt);
  await withTenant(tx, organizationId, (inner) =>
    inner
      .update(licenseUsage)
      .set({ transactions: sql`${licenseUsage.transactions} - 1`, updatedAt: new Date() })
      .where(
        and(
          eq(licenseUsage.licenseId, license.id),
          eq(licenseUsage.periodStart, period.start),
          gt(licenseUsage.transactions, 0),
        ),
      ),
  );
}

/** This license month's counted transactions (0 before the first one). */
export async function licenseTransactionsUsed(
  db: DrizzleDb,
  organizationId: string,
  license: Pick<License, 'id'>,
  periodStart: Date,
): Promise<number> {
  return withTenant(db, organizationId, async (tx) => {
    const [row] = await tx
      .select({ transactions: licenseUsage.transactions })
      .from(licenseUsage)
      .where(and(eq(licenseUsage.licenseId, license.id), eq(licenseUsage.periodStart, periodStart)));
    return row?.transactions ?? 0;
  });
}
