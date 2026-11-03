# Console Google login

Set `CONSOLE_GOOGLE_CLIENT_ID` to the same Google OAuth Web client ID used by
the business/admin portal's `VITE_GOOGLE_CLIENT_ID`. Apply migrations 0014 through
0017 with `npm run db:migrate` before starting this version of Core. No OAuth
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

Public wire shapes live in @octap/contracts. Portal methods are not part of the customer Browser SDK.
Web's real routes currently call Core directly with fetch and Google ID tokens; no
OctaP SDK is installed in Web. The old mock dashboards are opt-in demo routes.
Google subject binding and explicit platform role provisioning remain separate from
invitation acceptance. No bootstrap email/domain rule grants System Admin automatically.

## OCT-63 staff access and first Owner

Owner-only `PATCH /v1/console/organizations/:organizationId/staff/:userId`
accepts exactly `{ "status": "ACTIVE" | "SUSPENDED" }`. The target ID is a system
user ID from the staff list. Only Business Developer memberships can be changed;
Owner changes and role promotion are rejected. Authorization and the update run in
one transaction, locking the organization before its memberships. System Admin
status does not bypass tenant membership. Suspension revokes pending invitations
for that account's stored email; acceptance also rejects invitations issued at or before
the suspension, even if Google reports a newer verified email. Owners can explicitly
restore access or issue a new invitation. The existing Team page provides Suspend/Restore controls.

System Admin-only `POST /v1/platform/organizations/:organizationId/owner` accepts
`{ "systemUserId": "<uuid>" }` for an existing Google-bound account. It creates the
first Owner of an ACTIVE organization, including promoting an existing Developer.
Any existing Owner membership, even suspended, rejects this bootstrap with 409.
Concurrent attempts serialize on the organization. Pending applications must use
the approval workflow. This endpoint is not ownership transfer or account recovery;
those governance workflows remain OCT-208. There is no bootstrap form in Web.

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
require the key.

Organization approval establishes portal membership, not verified civil identity,
company registration, or a provisioned Sui program. CCCD document verification and
resumable server-side onboarding drafts are still separate future work.

## Operator bootstrap and explicit account linking

After migrations and `npm run build`, use `scripts/console-operator.mjs` on a trusted
operator host with Core's `DATABASE_URL` and `CONSOLE_GOOGLE_CLIENT_ID`. The target
person supplies a freshly issued Google ID token for this same OAuth client. Pass
it via stdin from secure input; never put it in arguments, logs or version control.
The script verifies the token with the same Google verifier as console login.

### Obtain a fresh Google ID token

Use the existing business portal with the same public Google OAuth Web client ID as
Core's `CONSOLE_GOOGLE_CLIENT_ID`. Its origin must be registered in Google's
Authorized JavaScript origins. This procedure needs no client secret or token-display UI.

1. On a trusted development machine, open the portal and browser DevTools **Network**
   panel before signing in. Clear earlier requests so an old credential is not selected.
2. Click **Sign in with Google** and choose the intended account. Find the portal's
   POST `/v1/console/auth/google` request. In **Payload / Request Payload**, copy only
   the `idToken` string value (without JSON quotes). A legacy account can return 409;
   the request still contains the Google credential needed for explicit linking.
3. Run the operator command promptly on the trusted operator host. Paste the value
   into masked input and pipe it through stdin, as shown below. Do not copy a cURL
   command, place the token in shell arguments/history, capture it in screenshots,
   export a HAR, or send it through an issue, chat or shared log.
4. Clear the token from the clipboard and DevTools after use. If it expires, repeat
   Google sign-in; do not use a Google API access token or an old Network request.

PowerShell example, from the Core repository after build, using a development
database and an existing restricted audit directory:

```powershell
$operatorToken = Read-Host 'Paste the fresh Google ID token' -AsSecureString
try {
  $operatorCredential = [System.Net.NetworkCredential]::new('', $operatorToken)
  $operatorCredential.Password | node --env-file=.env scripts/console-operator.mjs --action bootstrap-admin --operator 'Your name' --reason 'Initial development admin' --audit-file 'D:\secure\console-audit.jsonl'
  if ($LASTEXITCODE -ne 0) { throw 'Operator action did not report success; inspect its audit record.' }
} finally {
  $operatorToken.Dispose()
  Remove-Variable operatorToken, operatorCredential -ErrorAction SilentlyContinue
}
```

For an existing legacy administrator, use `--action link --user-id EXISTING_USER_UUID`
instead of bootstrap. To select a legacy account when creating the first administrator,
add `--user-id EXISTING_USER_UUID` to bootstrap explicitly. Never obtain a subject by
decoding the token yourself: the script verifies it against Google before changing data.
The credential exists briefly in process memory for stdin transport; masked input
avoids placing its value in shell history or on screen.

The documented flow does not establish real-account acceptance by itself. Run and
inspect the script's successful audit record with a real Google account on a development
database after merge; keep that acceptance criterion open until it has been done.

### Operator commands and audit

Command shape (pipe the token securely into stdin):

```text
node --env-file=.env scripts/console-operator.mjs --action bootstrap-admin --operator NAME --reason REASON --audit-file ABSOLUTE_AUDIT_PATH
node --env-file=.env scripts/console-operator.mjs --action link --user-id EXISTING_USER_UUID --operator NAME --reason REASON --audit-file ABSOLUTE_AUDIT_PATH
```

`bootstrap-admin` creates the first SYSTEM_ADMIN or promotes the already Google-bound
user. For a legacy email collision, explicitly include `--user-id EXISTING_USER_UUID`;
it never links by email automatically. It refuses bootstrap once any admin exists.
`link` requires a selected existing user ID, preserves the current system role and
matches its email to the verified Google identity. It refuses a different existing
subject or a subject owned by another user. To link an existing legacy admin use
`link`, since that admin already counts as provisioned. No public provisioning endpoint
or email/domain allowlist is added. Keep database access limited to trusted operators.

The append-only JSONL audit file records operation ID, time, supplied operator/reason,
OS username, host, action, target ID, and before/after email, role and Google subject.
Tokens and password hashes are never recorded. `prepared` is flushed before commit;
a failed audit write rolls back the mutation. `committed` confirms success; a prepared
entry without committed (or failed-or-commit-unconfirmed) requires checking the database
before retrying. Serializable transactions prevent two simultaneous initial admins.
Retain the file outside the repository with restricted permissions and your operational
logs; the supplied name is operator attribution, not an independently authenticated actor.

## After organization approval

Approval creates an ACTIVE organization and its Owner membership, not an on-chain
program or merchant API credential. Portal UI cannot issue either yet. On a configured
operator/worker host, after build, run:

```text
node --env-file=.env scripts/provision-program.mjs ORGANIZATION_UUID EARN_BPS EXPIRY_DAYS TOTAL_BUDGET SHARD_COUNT
node --env-file=.env scripts/seed-dev-credential.mjs ORGANIZATION_UUID CREDENTIAL_NAME
```

Choose actual policy values and budgets, configure the existing Sui program-admin and
issuer signer settings per docs/kms-signer.md, and fund the required testnet signers
before provisioning. Provisioning calls the chain and records the program in Core.
The credential command prints the raw merchant key once: store it in server-side secret
management, never Web/Vite config or logs shared with reviewers. It grants read/write/admin
merchant scopes; it does not grant a human SYSTEM_ADMIN role. The Developer portal reads
safe credential metadata only. Start the configured chain-submit worker for earn/redeem
processing. These commands are operator steps; approval alone is not an end-to-end earn test.


## Requested slug history

Creation snapshots the requested slug in `organization_change_requests.payload.requestedSlug`.
Application listings show that value without exposing the raw request payload. Rejection still
archives the organization and releases its public slug for another application. Decisions also
snapshot the current slug for older pending requests that lack the field, before replacing it.
Historical rows already rejected without a snapshot fall back to their stored organization slug;
the original lost value cannot be reconstructed safely from the organization name. No migration
or guess at historical slugs is performed.
