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
export interface ConsoleCredential {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: unknown;
  status: string;
}
