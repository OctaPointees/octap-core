import { relations } from 'drizzle-orm';
import {
  systemUsers,
  invitations,
  organizationMemberships,
  organizationChangeRequests,
} from './auth.schema.js';
import { organizations, apiCredentials } from './organizations.schema.js';
import { endUsers, organizationEndUsers } from './members.schema.js';
import {
  creditOwnerships,
  blockchainTransactions,
  loyaltyTransactions,
} from './credits.schema.js';
import { vouchers, voucherOwnerships } from './rewards.schema.js';
import {
  billingPlans,
  paymentMethods,
  subscriptions,
  invoices,
} from './billing.schema.js';

// SYSTEM USERS RELATIONS
export const systemUsersRelations = relations(systemUsers, ({ many }) => ({
  memberships: many(organizationMemberships),
  invitationsSent: many(invitations),
  changeRequestsCreated: many(organizationChangeRequests, { relationName: 'requestedBy' }),
  changeRequestsReviewed: many(organizationChangeRequests, { relationName: 'reviewedBy' }),
}));

// INVITATIONS RELATIONS
export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
  invitedBy: one(systemUsers, {
    fields: [invitations.invitedById],
    references: [systemUsers.id],
  }),
}));

// ORGANIZATION MEMBERSHIPS RELATIONS
export const organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [organizationMemberships.organizationId],
      references: [organizations.id],
    }),
    systemUser: one(systemUsers, {
      fields: [organizationMemberships.systemUserId],
      references: [systemUsers.id],
    }),
    loyaltyTransactionsCreated: many(loyaltyTransactions),
  }),
);

// ORGANIZATIONS RELATIONS
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships),
  invitations: many(invitations),
  changeRequests: many(organizationChangeRequests),
  apiCredentials: many(apiCredentials),
  organizationEndUsers: many(organizationEndUsers),
  loyaltyTransactions: many(loyaltyTransactions),
  vouchers: many(vouchers),
  paymentMethods: many(paymentMethods),
  subscriptions: many(subscriptions),
  invoices: many(invoices),
}));

// ORGANIZATION CHANGE REQUESTS RELATIONS
export const organizationChangeRequestsRelations = relations(
  organizationChangeRequests,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationChangeRequests.organizationId],
      references: [organizations.id],
    }),
    requestedBy: one(systemUsers, {
      fields: [organizationChangeRequests.requestedById],
      references: [systemUsers.id],
      relationName: 'requestedBy',
    }),
    reviewedBy: one(systemUsers, {
      fields: [organizationChangeRequests.reviewedById],
      references: [systemUsers.id],
      relationName: 'reviewedBy',
    }),
  }),
);

// API CREDENTIALS RELATIONS
export const apiCredentialsRelations = relations(apiCredentials, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiCredentials.organizationId],
    references: [organizations.id],
  }),
}));

// END USERS RELATIONS
export const endUsersRelations = relations(endUsers, ({ many }) => ({
  organizationProfiles: many(organizationEndUsers),
}));

// ORGANIZATION END USERS RELATIONS
export const organizationEndUsersRelations = relations(
  organizationEndUsers,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [organizationEndUsers.organizationId],
      references: [organizations.id],
    }),
    endUser: one(endUsers, {
      fields: [organizationEndUsers.endUserId],
      references: [endUsers.id],
    }),
    creditOwnership: one(creditOwnerships),
    voucherOwnerships: many(voucherOwnerships),
    loyaltyTransactions: many(loyaltyTransactions),
  }),
);

// CREDIT OWNERSHIPS RELATIONS
export const creditOwnershipsRelations = relations(creditOwnerships, ({ one }) => ({
  organizationEndUser: one(organizationEndUsers, {
    fields: [creditOwnerships.organizationEndUserId],
    references: [organizationEndUsers.id],
  }),
}));

// BLOCKCHAIN TRANSACTIONS RELATIONS
export const blockchainTransactionsRelations = relations(
  blockchainTransactions,
  ({ many }) => ({
    loyaltyTransactions: many(loyaltyTransactions),
  }),
);

// LOYALTY TRANSACTIONS RELATIONS
export const loyaltyTransactionsRelations = relations(
  loyaltyTransactions,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [loyaltyTransactions.organizationId],
      references: [organizations.id],
    }),
    organizationEndUser: one(organizationEndUsers, {
      fields: [loyaltyTransactions.organizationEndUserId],
      references: [organizationEndUsers.id],
    }),
    createdByMembership: one(organizationMemberships, {
      fields: [loyaltyTransactions.createdByMembershipId],
      references: [organizationMemberships.id],
    }),
    blockchainTransaction: one(blockchainTransactions, {
      fields: [loyaltyTransactions.blockchainTransactionId],
      references: [blockchainTransactions.id],
    }),
    voucherOwnerships: many(voucherOwnerships),
  }),
);

// VOUCHERS RELATIONS
export const vouchersRelations = relations(vouchers, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [vouchers.organizationId],
    references: [organizations.id],
  }),
  ownerships: many(voucherOwnerships),
}));

// VOUCHER OWNERSHIPS RELATIONS
export const voucherOwnershipsRelations = relations(voucherOwnerships, ({ one }) => ({
  voucher: one(vouchers, {
    fields: [voucherOwnerships.voucherId],
    references: [vouchers.id],
  }),
  organizationEndUser: one(organizationEndUsers, {
    fields: [voucherOwnerships.organizationEndUserId],
    references: [organizationEndUsers.id],
  }),
  loyaltyTransaction: one(loyaltyTransactions, {
    fields: [voucherOwnerships.loyaltyTransactionId],
    references: [loyaltyTransactions.id],
  }),
}));

// BILLING PLANS RELATIONS
export const billingPlansRelations = relations(billingPlans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

// PAYMENT METHODS RELATIONS
export const paymentMethodsRelations = relations(paymentMethods, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [paymentMethods.organizationId],
    references: [organizations.id],
  }),
  subscriptions: many(subscriptions),
  invoices: many(invoices),
}));

// SUBSCRIPTIONS RELATIONS
export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [subscriptions.organizationId],
    references: [organizations.id],
  }),
  billingPlan: one(billingPlans, {
    fields: [subscriptions.billingPlanId],
    references: [billingPlans.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [subscriptions.paymentMethodId],
    references: [paymentMethods.id],
  }),
  invoices: many(invoices),
}));

// INVOICES RELATIONS
export const invoicesRelations = relations(invoices, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [invoices.paymentMethodId],
    references: [paymentMethods.id],
  }),
  organization: one(organizations, {
    fields: [invoices.organizationId],
    references: [organizations.id],
  }),
}));
