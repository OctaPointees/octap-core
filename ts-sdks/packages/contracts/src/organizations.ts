export interface ProvisionOrganizationInput {
  earnBps: number;
  expiryDays: number;
  totalBudget: number;
  shardCount: number;
  idempotencyKey: string;
}
export interface OrganizationProvisioningStatus {
  operationId: string;
  status: string;
  errorMessage: string | null;
  updatedAt: string;
}
export interface PlatformOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  organizationType: string | null;
  legalName: string | null;
  taxId: string | null;
  representativeName: string | null;
  programStatus: string | null;
  programControlId: string | null;
  createdAt: string;
  provisioning: OrganizationProvisioningStatus | null;
}
