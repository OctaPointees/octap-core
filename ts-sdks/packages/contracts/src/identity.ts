export interface GoogleLoginRequest {
  idToken: string;
}

export interface GoogleLoginResponse {
  endUserId: string;
  suiAddress: string;
  isNewUser: boolean;
}

export interface EnrollMemberRequest {
  endUserId: string;
  externalMemberId?: string;
}

export interface EnrollMemberResponse {
  organizationEndUserId: string;
  isNewEnrollment: boolean;
}
