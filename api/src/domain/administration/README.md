# Organization governance (OCT-208)

System Admin-only platform endpoints list/filter/page `organization_change_requests`
and approve/reject with a required reason. Decisions atomically apply the requested
effect, store reviewer/time/reason, and reject terminal requests with 409.

Owners submit POST `/v1/console/organizations/:id/change-requests`; System Admins use
POST `/v1/platform/organizations/:id/change-requests`. GET `/v1/platform/change-requests`
supports status, organizationId, limit 1–100 and UUID cursor. POST `/:id/approve|reject`
under that path requires `{reason}`. CREATE_ORGANIZATION decisions delegate to the
existing onboarding transaction, including initial Owner assignment and rejected slug release.

Other proposal bodies are `{requestType,reason,payload}`:

- TRANSFER_OWNERSHIP: `{targetUserId}` must select an active, Google-bound Developer
  in that organization. Exactly one active Owner is required. Approval demotes the
  previous Owner to active Developer and promotes the target to Owner in one transaction.
  Changed ownership/target eligibility rejects stale approval; roles cannot be chosen in payloads.
- UPDATE_PROFILE: `{name}` is available only to System Admins. Owners rename directly
  through the existing profile endpoint.
- UPDATE_IDENTITY: any of `{legalName, taxId, representativeName, nationalId, organizationType}`,
  at least one. Owners and System Admins can propose it; it is the only way legal details change
  (OCT-281). `organizationType` only classifies an organization that has none. The result must
  satisfy the setup rules for its type (a company keeps a legal name and tax number and has no CCCD;
  a household keeps a representative). One pending request per organization (409). The payload
  records the current details as `expected`, and approval rejects with 409 if they moved. The CCCD
  is stored encrypted in `organization_change_request_secrets`, never in the payload (only its last
  four digits); approval copies the ciphertext into `organization_identity_details`, and either
  decision deletes the row. See `docs/console-google-login.md`.
- BUDGET_TOP_UP: `{amount}` is a positive whole number of points. Owners and System Admins can propose it.
  Approval needs an active program and queues one durable command in the same transaction, which the
  worker with `ORG_PROVISION_WORKER_ENABLED=true` executes. An unknown chain outcome becomes UNKNOWN and is
  never retried. A top-up raises how many points may be issued; no money moves.
- SUSPEND: `{}` changes ACTIVE to SUSPENDED.
- REINSTATE: `{}` is proposed by System Admin and changes SUSPENDED to ACTIVE.
- DEACTIVATE: `{}` permanently changes ACTIVE to ARCHIVED; reinstatement is not recovery
  from archive. These are explicit enum values, added by migration 0018 for the two new types.

All proposals snapshot organization status and retain the submission reason in payload
when the decision replaces the request reason. An unexpected current status rejects approval.
Rejection changes only the request. There is no maker/checker restriction beyond System Admin
authorization: an admin may review their own platform proposal under this scoped policy.

Portal memberships are hidden/denied while the organization is inactive. The API-key guard
joins organization status on every lookup; existing valid credentials work again after
reinstatement, but revoked/expired keys and inactive memberships remain invalid. New earn/POS
acceptance additionally locks eligibility (OCT-71); vouchers already check it. Already accepted
chain work can settle/reconcile to avoid stranding holds or contradicting chain results.

Worker suspension is not cancellation of on-chain transactions. No live database or chain
state was modified by the tests; apply migrations as part of deployment before these routes.
