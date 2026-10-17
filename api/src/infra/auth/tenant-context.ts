/** Resolved server-side from a validated API credential; never trust a client-supplied org id instead. */
export interface TenantContext {
  organizationId: string;
  credentialId: string;
  scopes: string[];
}
