/** Platform identity roles. Organization membership is a separate authorization dimension. */
export const SYSTEM_ROLES = ['SYSTEM_USER', 'SYSTEM_ADMIN'] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export type OrganizationPersona = 'BUSINESS_OWNER' | 'BUSINESS_DEVELOPER';

export interface ConsoleIdentity {
  user: { id: string; email: string; fullName: string; avatarUrl: string | null; systemRole: SystemRole };
  organizations: Array<{ organizationId: string; name: string; slug: string; persona: OrganizationPersona }>;
  /** Expiration of the Google credential; Core does not issue a separate console token. */
  expiresAt: string;
}
