import type { OrganizationPersona } from './system-users.js';

export type OrganizationType = 'INDIVIDUAL_HOUSEHOLD' | 'COMPANY';
export interface OrganizationProfileInput {
  /** Existing legacy organizations can classify their type once. */
  organizationType?: OrganizationType;
  name: string;
  legalName?: string;
  taxId?: string;
  representativeName?: string;
  /** Optional replacement CCCD, write-only. Verification is not implemented yet. */
  nationalId?: string;
}
export interface OrganizationApplicationInput extends OrganizationProfileInput {
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
