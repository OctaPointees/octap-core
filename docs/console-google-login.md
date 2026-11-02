# Console Google login

Set `CONSOLE_GOOGLE_CLIENT_ID` to the same Google OAuth Web client ID used by
the business/admin portal's `VITE_GOOGLE_CLIENT_ID`. Apply migrations 0014 and
0015 and 0016 with `npm run db:migrate` before starting this version of Core. No OAuth
client secret is required for this Google Identity Services ID-token flow.

`POST /v1/console/auth/google` accepts `{ "idToken": "<Google ID token>" }`.
`GET /v1/console/me` accepts `Authorization: Bearer <Google ID token>`.
Both verify the credential using Google's library (signature/JWKS, issuer,
audience, expiry, verified email and authorized party). They return the public
`ConsoleIdentity` contract; no Core session or wallet is created.

Core binds Google `sub` to a unique `system_users.google_subject`. First login
creates a SYSTEM_USER. An email collision with an unlinked legacy account
returns 409: an authorized administrator must verify ownership and attach its
Google subject through a controlled operation. There is no public linking or
self-promotion API. Never populate a subject from an unverified client claim.

Platform roles come only from `system_users.system_role`. Tenant personas come
only from active memberships in active organizations: OWNER maps to
BUSINESS_OWNER and BUSINESS_DEVELOPER maps to BUSINESS_DEVELOPER. Other legacy
membership roles remain stored but do not automatically receive portal access.
Membership reads run under the authenticated user's RLS context. Every refresh
reads current roles/memberships; identity responses contain no password hash,
Google subject, or arbitrary account metadata.

Protected console routes use ConsoleAccessGuard to verify the Google bearer credential
on every request. The organization repository rechecks the active membership, exact
persona and organization status inside its database transaction. Platform request
review requires SYSTEM_ADMIN in both the route guard and the transaction; a platform
administrator receives no implicit tenant membership.

## Organization onboarding

- POST/GET `/v1/console/organization-requests`: submit a validated name/slug/profile
  and read the actor's own requests. Reserved slugs reject; slugs are unique.
- GET `/v1/platform/organization-requests` and POST `/:id/approve` or `/:id/reject`:
  System Admin review. Approval atomically activates the pending organization, creates
  the applicant's OWNER membership and records the reviewer/time. Rejection requires
  a reason, archives the pending organization and creates no membership. Decisions
  are terminal (409 on replay), including concurrent decisions.
- GET `/v1/console/organizations/:id`: active Owner/Developer organization detail.
- PATCH `/:id/profile`, GET `/:id/staff`: Owner-only profile/staff operations.
- GET `/:id/api-credentials`: Owner/Developer metadata listing; never returns raw keys
  or key hashes. Lists are bounded to 100 rows.

This is the CREATE_ORGANIZATION portion of the coordinated governance workflow.
Chain provisioning, wildcard DNS, other change request types, full staff role changes,
credential issuance and customer member-directory operations remain separate work.
Do not treat organization approval as a provisioned on-chain program.

## Invitations

Owner-only POST/GET `/v1/console/organizations/:id/invitations` creates/lists Developer
invitations. POST `/:id/invitations/:invitationId/revoke` revokes a pending invitation.
A token consists of 32 random bytes; only its SHA-256 hash is stored. The raw token is
returned once at creation. Email is normalized. An existing pending invitation rejects
with 409; expired pending rows are retired so an Owner can invite again. Migration
0016 changes the old unconditional organization/email index into a pending-only unique
index, retaining accepted/revoked history. Invitations and change requests enable RLS
with no public policies: only the server's explicitly authorized workflows may access
them, not the anon/authenticated Data API roles.

POST `/v1/console/invitations/:token/accept` requires a verified Google bearer token,
matching current verified Google email, a pending/unexpired invitation, active
organization, and an inviter who is still an active Owner. It creates/reactivates only
BUSINESS_DEVELOPER membership and marks the invitation accepted atomically. Existing
active membership is not overwritten. Bad tokens are 404; consumed/revoked/expired
ones are 410; unauthorized actors/tenants are 403. No password/account-claim form and
no automatic email delivery are introduced. The raw link must be shared by the Owner.

Public wire shapes and optional SDK methods live in the contracts/browser packages.
Web's real routes currently call Core directly with fetch and Google ID tokens; no
OctaP SDK is installed in Web. The old mock dashboards are opt-in demo routes.
Google subject binding and explicit platform role provisioning remain separate from
invitation acceptance. No bootstrap email/domain rule grants System Admin automatically.

## Organization setup types and deferred CCCD verification

Migration 0017 adds nullable `organization_type` (INDIVIDUAL_HOUSEHOLD / COMPANY)
and `representative_name`. Existing organizations keep a null type. New requests must
choose explicitly. Individual/household requests require a representative name;
companies require their legal name and business registration/tax number. Inputs are
format-checked, not verified against a civil/business registry. Owner-only profile
updates allow one-time classification of legacy organizations and retain required
fields; ordinary edits cannot switch an established type.

Optional 12-digit CCCD values live in `organization_identity_details`, encrypted with
AES-256-GCM using fresh IVs and organization-ID associated data. The table enables RLS
with no public policies. Only Core's authorized server workflows access it. Applicant
and platform request listings return a last-four mask, never ciphertext or plaintext.
Organization detail returns the mask only to Owners; Developers do not receive it.
Owners can replace a value, while omission preserves it. No verification flag can be
set through these requests. There is no plaintext CCCD read endpoint.

Set `ORGANIZATION_IDENTITY_ENCRYPTION_KEY` to a stable, secret, base64-encoded 32-byte
key on Core only. Generate it once with a cryptographically secure random generator
and retain it in secret management; never place it in Vite configuration or commit it.
Do not overwrite the key on restart: existing ciphertext depends on it. Key rotation
must retain the old key until data has been re-encrypted. Missing/malformed keys reject
CCCD writes with 503 and roll back the entire operation. Requests without CCCD do not
require the key. The local ignored .env has been configured for the development demo.

Organization approval establishes portal membership, not verified civil identity,
company registration, or a provisioned Sui program. CCCD document verification and
resumable server-side onboarding drafts are still separate future work.
