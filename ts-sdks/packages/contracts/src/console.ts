import type { CreateVoucherRequest } from './rewards.js';
import type { OrganizationPersona } from './system-users.js';

export type OrganizationType = 'INDIVIDUAL_HOUSEHOLD' | 'COMPANY';
/**
 * `PATCH /v1/console/organizations/:id/profile`: display details, applied immediately. Send at least
 * one field. Legal details (legal name, tax ID, representative, CCCD, type) change only through an
 * `UPDATE_IDENTITY` change request; a legal field sent here must equal the stored value, else 400.
 */
export interface OrganizationProfileInput {
  /** 2–160 characters. */
  name?: string;
  /** An `https:` URL of up to 2048 characters, or `null` to remove the logo. */
  logoUrl?: string | null;
}
/** The legal details an organization is registered with. */
export interface OrganizationIdentityInput {
  legalName?: string;
  taxId?: string;
  representativeName?: string;
  /** CCCD, 12 digits, write-only: responses only ever return its last four digits. */
  nationalId?: string;
}
export interface OrganizationApplicationInput extends OrganizationIdentityInput {
  name: string;
  slug: string;
  organizationType: OrganizationType;
}
export interface OrganizationApplication {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason: string | null;
  createdAt: string;
  applicantEmail: string;
  initialOwnerName?: string | null;
  initialOwnerEmail?: string | null;
  organizationType: OrganizationType | null;
  legalName: string | null;
  taxId: string | null;
  representativeName: string | null;
  nationalIdLast4: string | null;
}
export interface ConsoleOrganization {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  taxId: string | null;
  status: string;
  persona: OrganizationPersona;
  organizationType: OrganizationType | null;
  representativeName: string | null;
  logoUrl: string | null;
  /** Returned only to Business Owners. Never the full CCCD. */
  nationalIdLast4?: string | null;
}
export interface ConsoleStaff {
  id: string;
  fullName: string;
  email: string;
  persona: OrganizationPersona;
  status: string;
}
export interface ConsoleInvitation {
  id: string;
  email: string;
  persona: 'BUSINESS_DEVELOPER';
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: string;
}
export interface CreatedConsoleInvitation extends ConsoleInvitation {
  token: string;
}
/** An organization's API key as the console lists it: never the raw key or its hash. */
export interface ConsoleCredential {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdAt: string;
  /** Approximate: recorded after each authenticated request, not inside it. */
  lastUsedAt: string | null;
}
/** Returned once, when the key is created: store `rawKey` now, it cannot be read again. */
export interface CreatedConsoleCredential extends ConsoleCredential {
  rawKey: string;
}
export interface ConsoleCredentialInput {
  /** 1–100 characters. */
  name: string;
  /**
   * `read` (the default) grants `['read']`; `write` grants `['read', 'write']` and only the Owner may
   * ask for it. A Business Developer revokes and renames read keys only.
   */
  scope?: 'read' | 'write';
}
export interface ConsoleCredentialPatch {
  /** 1–100 characters. */
  name: string;
}
export interface ConsoleGoogleLoginInput {
  /** Google ID token from the console sign-in. */
  idToken: string;
}
export interface ConsoleStaffAccessPatch {
  status: 'ACTIVE' | 'SUSPENDED';
}
export interface ConsoleInvitationInput {
  /** @format email */
  email: string;
  persona?: 'BUSINESS_DEVELOPER';
}

/**
 * Creating a voucher from the console session, which is stricter than `CreateVoucherRequest`: it is
 * always a `DRAFT`, activated afterwards with `PATCH { status: 'ACTIVE' }`, and `pointsCost` must be
 * sent (0 for a free reward). Only the Owner may create one.
 */
export interface ConsoleVoucherInput extends Omit<CreateVoucherRequest, 'status'> {
  pointsCost: number;
  /** Only `DRAFT`, which is also the default; any other status is a 400. */
  status?: 'DRAFT';
}
