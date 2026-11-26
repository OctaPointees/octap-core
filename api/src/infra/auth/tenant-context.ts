/** Resolved server-side from a validated API credential; never trust a client-supplied org id instead. */
export interface TenantContext {
  organizationId: string;
  credentialId: string;
  scopes: string[];
  /** The key's environment: a SANDBOX key's earns and redemptions never reach the chain (OCT-297). */
  environment: 'LIVE' | 'SANDBOX';
}
