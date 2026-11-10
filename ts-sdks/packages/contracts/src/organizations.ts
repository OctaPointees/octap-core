import type { OrganizationApplicationInput } from './console.js';
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
/** `GET /v1/platform/organizations` query. */
export interface PlatformOrganizationListQuery {
  /** 1–100, default 25. */
  limit?: number;
  /** @format uuid */
  cursor?: string;
  status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL' | 'ARCHIVED';
  /** Name or slug search, up to 160 characters. */
  q?: string;
}
/** `POST /v1/platform/organizations`: a System Admin applies on behalf of an existing Google user. */
export interface PlatformOrganizationInput extends OrganizationApplicationInput {
  /** @format uuid */
  ownerUserId: string;
}
