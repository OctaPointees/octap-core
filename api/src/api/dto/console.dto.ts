import type {
  ConsoleCredentialInput,
  ConsoleCredentialPatch,
  ConsoleGoogleLoginInput,
  ConsoleInvitationInput,
  ConsoleStaffAccessPatch,
  ConsoleVoucherInput,
  GovernanceProposal,
  GovernanceRequestListQuery,
  MemberDirectoryQuery,
  MemberProfilePatch,
  OrganizationApplicationInput,
  OrganizationProfileInput,
  PlatformOrganizationInput,
  PlatformOrganizationListQuery,
  ProvisionOrganizationInput,
  ReviewDecisionInput,
} from '@octap/contracts';

// The same fields as `T`, as an anonymous object type. The console and platform services still take
// `Record<string, unknown>` and validate every field themselves, and an interface is not assignable
// to that, so controllers declare `Wire<…>`: it documents the body (and drives the OpenAPI schema)
// without promising the service anything it does not check. A line comment, not JSDoc, so it does
// not end up as the description of every generated schema.
export type Wire<T> = { [K in keyof T]: T[K] };

export type ConsoleGoogleLoginBodyDto = Wire<ConsoleGoogleLoginInput>;
export type ConsoleVoucherBodyDto = Wire<ConsoleVoucherInput>;
export type ReviewDecisionBodyDto = Wire<ReviewDecisionInput>;
export type GovernanceProposalBodyDto = Wire<GovernanceProposal>;
export type GovernanceRequestListQueryDto = Wire<GovernanceRequestListQuery>;
export type OrganizationApplicationBodyDto = Wire<OrganizationApplicationInput>;
export type OrganizationProfileBodyDto = Wire<OrganizationProfileInput>;
export type ConsoleStaffAccessBodyDto = Wire<ConsoleStaffAccessPatch>;
export type ConsoleInvitationBodyDto = Wire<ConsoleInvitationInput>;
export type ConsoleCredentialBodyDto = Wire<ConsoleCredentialInput>;
export type ConsoleCredentialPatchBodyDto = Wire<ConsoleCredentialPatch>;
export type MemberDirectoryQueryDto = Wire<MemberDirectoryQuery>;
export type MemberProfilePatchBodyDto = Wire<MemberProfilePatch>;
export type PlatformOrganizationListQueryDto = Wire<PlatformOrganizationListQuery>;
export type PlatformOrganizationBodyDto = Wire<PlatformOrganizationInput>;
export type ProvisionOrganizationBodyDto = Wire<ProvisionOrganizationInput>;
