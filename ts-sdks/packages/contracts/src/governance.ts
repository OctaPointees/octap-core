export type GovernanceRequestType =
  'UPDATE_PROFILE' | 'TRANSFER_OWNERSHIP' | 'DEACTIVATE' | 'BUDGET_TOP_UP' | 'SUSPEND' | 'REINSTATE';
export interface GovernanceProposal {
  requestType: GovernanceRequestType;
  reason: string;
  payload: { name?: string; targetUserId?: string; amount?: number };
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
