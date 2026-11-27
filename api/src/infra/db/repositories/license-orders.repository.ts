import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt } from 'drizzle-orm';
import { LICENSE_ORDER_TTL_HOURS, LICENSE_PAYMENT_CODE_PREFIX } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { licenseOrders } from '../schema/licensing.schema.js';
import { withTenant } from '../rls.js';
import type { LicensePlan } from './licenses.repository.js';

export type LicenseOrder = typeof licenseOrders.$inferSelect;

/** Codes drawn before giving up; with 10^8 codes a clash is already rare, two in a row rarer still. */
const PAYMENT_CODE_ATTEMPTS = 5;

/** `OCTAP` and 8 random digits. Unique across every organization: a payment finds its order by it. */
export const newPaymentCode = (): string =>
  `${LICENSE_PAYMENT_CODE_PREFIX}${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

/** A PENDING order that can no longer be paid counts as expired. */
export const isExpired = (order: Pick<LicenseOrder, 'status' | 'expiresAt'>, now: Date): boolean =>
  order.status === 'PENDING' && order.expiresAt <= now;

/**
 * Orders to buy or renew a license (OCT-330 part 1). Each method that writes joins a transaction
 * that already holds the organization's row FOR UPDATE (the Owner check), so two orders created at
 * once queue up and only one stays PENDING.
 */
@Injectable()
export class LicenseOrdersRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * The organization's order for `plan` and `termMonths`. A payable PENDING order for the same plan
   * and term is returned as it is (`created: false`), so a second click doesn't make a second order.
   * A payable one for anything else is CANCELED first, so an old QR code can't be paid by mistake.
   * The amount is worked out here from the plan, never taken from the request.
   */
  async place(
    tx: DrizzleDb,
    params: { organizationId: string; plan: LicensePlan; termMonths: number; createdById: string; now?: Date },
  ): Promise<{ order: LicenseOrder; created: boolean }> {
    const now = params.now ?? new Date();
    return withTenant(tx, params.organizationId, async (inner) => {
      const [open] = await inner
        .select()
        .from(licenseOrders)
        .where(
          and(
            eq(licenseOrders.organizationId, params.organizationId),
            eq(licenseOrders.status, 'PENDING'),
            gt(licenseOrders.expiresAt, now),
          ),
        )
        .orderBy(desc(licenseOrders.createdAt))
        .limit(1)
        .for('update');
      if (open && open.planId === params.plan.id && open.termMonths === params.termMonths)
        return { order: open, created: false };
      if (open)
        await inner
          .update(licenseOrders)
          .set({ status: 'CANCELED', updatedAt: now })
          .where(eq(licenseOrders.id, open.id));

      for (let attempt = 0; attempt < PAYMENT_CODE_ATTEMPTS; attempt += 1) {
        const [order] = await inner
          .insert(licenseOrders)
          .values({
            organizationId: params.organizationId,
            planId: params.plan.id,
            tier: params.plan.tier,
            planName: params.plan.name,
            termMonths: params.termMonths,
            amountVnd: params.plan.monthlyPriceVnd * params.termMonths,
            paymentCode: newPaymentCode(),
            expiresAt: new Date(now.getTime() + LICENSE_ORDER_TTL_HOURS * 60 * 60 * 1000),
            createdById: params.createdById,
          })
          .onConflictDoNothing({ target: licenseOrders.paymentCode })
          .returning();
        if (order) return { order, created: true };
      }
      throw new Error('Could not draw an unused payment code');
    });
  }

  /** The organization's orders, newest first. */
  list(organizationId: string, db: DrizzleDb = this.db): Promise<LicenseOrder[]> {
    return withTenant(db, organizationId, (tx) =>
      tx
        .select()
        .from(licenseOrders)
        .where(eq(licenseOrders.organizationId, organizationId))
        .orderBy(desc(licenseOrders.createdAt)),
    );
  }

  /** One of the organization's orders; another organization's is `undefined`. */
  async find(organizationId: string, orderId: string, db: DrizzleDb = this.db): Promise<LicenseOrder | undefined> {
    return withTenant(db, organizationId, async (tx) => {
      const [order] = await tx
        .select()
        .from(licenseOrders)
        .where(and(eq(licenseOrders.organizationId, organizationId), eq(licenseOrders.id, orderId)));
      return order;
    });
  }

  /**
   * Cancels a PENDING order, expired or not. `undefined` when the organization has no such order;
   * an order already PAID or CANCELED comes back unchanged, for the caller to refuse.
   */
  async cancel(
    tx: DrizzleDb,
    organizationId: string,
    orderId: string,
    now = new Date(),
  ): Promise<{ order: LicenseOrder; canceled: boolean } | undefined> {
    return withTenant(tx, organizationId, async (inner) => {
      const [order] = await inner
        .select()
        .from(licenseOrders)
        .where(and(eq(licenseOrders.organizationId, organizationId), eq(licenseOrders.id, orderId)))
        .for('update');
      if (!order) return undefined;
      if (order.status !== 'PENDING') return { order, canceled: false };
      const [canceled] = await inner
        .update(licenseOrders)
        .set({ status: 'CANCELED', updatedAt: now })
        .where(eq(licenseOrders.id, order.id))
        .returning();
      return { order: canceled, canceled: true };
    });
  }
}
