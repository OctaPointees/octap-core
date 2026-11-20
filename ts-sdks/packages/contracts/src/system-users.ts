import type { OrganizationType } from './console.js';

/** Platform identity roles. Organization membership is a separate authorization dimension. */
export const SYSTEM_ROLES = ['SYSTEM_USER', 'SYSTEM_ADMIN'] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export type OrganizationPersona = 'BUSINESS_OWNER' | 'BUSINESS_DEVELOPER';

export interface ConsoleIdentity {
  user: { id: string; email: string; fullName: string; avatarUrl: string | null; systemRole: SystemRole };
  organizations: Array<{
    organizationId: string;
    name: string;
    slug: string;
    persona: OrganizationPersona;
    /** The registered legal type, or null when the organization has none yet. */
    organizationType: OrganizationType | null;
    /** The registered legal representative, or null when the organization has none yet. */
    representativeName: string | null;
  }>;
  /** Expiration of the Google credential; Core does not issue a separate console token. */
  expiresAt: string;
}
