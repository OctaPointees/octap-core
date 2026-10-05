import { boolean, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.schema.js';

export const billingPlanIntervalEnum = pgEnum('billing_plan_interval', ['MONTHLY', 'ANNUAL']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'DRAFT',
  'OPEN',
  'PAID',
  'UNCOLLECTIBLE',
  'VOID',
]);

/**
 * BILLING PLAN: SaaS pricing plans and tiers for Organizations.
 */
export const billingPlans = pgTable('billing_plans', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').default('usd').notNull(),
  billingInterval: billingPlanIntervalEnum('billing_interval').default('MONTHLY').notNull(),
  stripePriceId: text('stripe_price_id'),
  features: jsonb('features').default({}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * PAYMENT METHOD: Stored payment instruments (e.g. Stripe card/account) for an Organization.
 */
export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  stripePaymentMethodId: text('stripe_payment_method_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  type: text('type').default('card').notNull(),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpMonth: integer('card_exp_month'),
  cardExpYear: integer('card_exp_year'),
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * SUBSCRIPTION: Organization recurring subscriptions to a Billing Plan.
 */
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  billingPlanId: uuid('billing_plan_id')
    .notNull()
    .references(() => billingPlans.id),
  paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, {
    onDelete: 'set null',
  }),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  status: subscriptionStatusEnum('status').default('ACTIVE').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * INVOICE: Recurring or one-off billing invoices.
 */
export const invoices = pgTable('invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => subscriptions.id, { onDelete: 'cascade' }),
  paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, {
    onDelete: 'set null',
  }),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  stripeInvoiceId: text('stripe_invoice_id').unique(),
  invoiceNumber: text('invoice_number').notNull(),
  amountDue: numeric('amount_due', { precision: 10, scale: 2 }).notNull(),
  amountPaid: numeric('amount_paid', { precision: 10, scale: 2 }).default('0.00').notNull(),
  currency: text('currency').default('usd').notNull(),
  status: invoiceStatusEnum('status').default('OPEN').notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  hostedInvoiceUrl: text('hosted_invoice_url'),
  invoicePdf: text('invoice_pdf'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
