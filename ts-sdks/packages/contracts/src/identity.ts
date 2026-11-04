export interface GoogleLoginRequest {
  idToken: string;
}

export interface GoogleLoginResponse {
  endUserId: string;
  suiAddress: string;
  isNewUser: boolean;
}

export interface EnrollMemberRequest {
  /** Proves which customer is enrolling; the end user is derived from it, never supplied. */
  idToken: string;
}

export interface EnrollMemberResponse {
  organizationEndUserId: string;
  /** The end user the id_token proved, so a caller can check it against the customer it expected. */
  endUserId: string;
  isNewEnrollment: boolean;
}

export interface VerifyCustomerRequest {
  idToken: string;
}

export interface VerifyCustomerResponse {
  /** Null when this Google account has never signed in to OctaP. */
  endUserId: string | null;
  suiAddress: string;
  /** The `organizationEndUserId` in the calling organization; null until the customer enrolls. */
  memberId: string | null;
  /** True only when reward operations will accept this member: enrolled and not blocked. */
  active: boolean;
}
