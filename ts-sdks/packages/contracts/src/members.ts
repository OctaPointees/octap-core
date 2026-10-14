/**
 * Minimal identity-binding slice of the `domain/members` roadmap item: looks up or creates an
 * end user by phone number within one organization, returning the `organizationEndUserId` every
 * credits/rewards endpoint needs. Not a full enrollment flow (no verification, no profile
 * editing) — just enough for a caller that only has a phone number to get a valid id.
 */
export interface EnsureMemberByPhoneRequest {
  phoneNumber: string;
  displayName?: string;
}

export interface EnsureMemberByPhoneResponse {
  organizationEndUserId: string;
  isNewMember: boolean;
}
