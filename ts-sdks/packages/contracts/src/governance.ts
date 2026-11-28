import type { OrganizationIdentityInput, OrganizationType } from './console.js';

export type GovernanceRequestType =
  | 'UPDATE_PROFILE'
  | 'TRANSFER_OWNERSHIP'
  | 'DEACTIVATE'
  | 'BUDGET_TOP_UP'
  | 'SUSPEND'
  | 'REINSTATE'
  | 'UPDATE_IDENTITY'
  | 'UPDATE_EARN_RATE';
/**
 * `UPDATE_IDENTITY` replaces an organization's legal details once a System Admin approves it. Send
 * at least one field; `organizationType` only classifies an organization that has none yet. The
 * stored request keeps only the CCCD's last four digits, never the number.
 */
export interface IdentityChangePayload extends OrganizationIdentityInput {
  organizationType?: OrganizationType;
}
export interface GovernanceProposal {
  requestType: GovernanceRequestType;
  reason: string;
  /**
   * `amount` for `BUDGET_TOP_UP`; `earnBps` (0–10000, points per 10,000 units of purchase) for
   * `UPDATE_EARN_RATE`, which replaces the organization's base earn rate once approved.
   */
  payload: { name?: string; targetUserId?: string; amount?: number; earnBps?: number } & IdentityChangePayload;
}
export interface GovernanceRequest {
  id: string;
  organizationId: string | null;
  requestedById: string;
  reviewedById: string | null;
  requesterEmail?: string;
  reviewerEmail?: string | null;
  initialOwnerName?: string | null;
  initialOwnerEmail?: string | null;
  requestType: GovernanceRequestType | 'CREATE_ORGANIZATION';
  status: string;
  payload: unknown;
  reason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}
export type GovernanceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
/** `GET /v1/platform/change-requests` query. */
export interface GovernanceRequestListQuery {
  /** 1–100, default 25. */
  limit?: number;
  /** @format uuid */
  cursor?: string;
  status?: GovernanceRequestStatus;
  /** @format uuid */
  organizationId?: string;
}
/** Body of an approve or reject decision. */
export interface ReviewDecisionInput {
  /** 1–1000 characters. */
  reason: string;
}
