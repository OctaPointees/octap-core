export interface GoogleLoginBodyDto {
  idToken: string;
}

export interface EnrollMemberBodyDto {
  idToken: string;
  externalMemberId?: string;
}

export interface VerifyCustomerBodyDto {
  idToken: string;
}

export interface ZkLoginNonceBodyDto {
  ephemeralPublicKey: string;
  additionalEpochs?: number;
}

export interface ZkLoginProofBodyDto {
  idToken: string;
  ephemeralPublicKey: string;
  randomness: string;
  maxEpoch: number;
}
