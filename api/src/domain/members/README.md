# Customer membership directory (OCT-71)

Google-authenticated console routes under `/v1/console/organizations/:organizationId/members`
read organization customer enrollments, not organization staff. Active Owner/Developer
membership in an ACTIVE organization is required; only Owners can PATCH a customer profile.
SYSTEM_ADMIN alone grants no tenant access. All database operations recheck permissions
inside a transaction and constrain every enrollment query by organization ID.

GET list supports `limit` 1–100 (default 25), UUID `cursor`, text `q`,
`status=ACTIVE|BLOCKED` and exact `externalMemberId`. Results use ascending enrollment UUID
and return `{items,nextCursor}`. `q` searches display name/email/phone/external ID with
literal wildcard escaping. GET `/:memberId` adds the current CreditsService balance,
including pending amounts, expiry handling, observation/checkpoint and stale indicators.

GET `/:memberId/transactions` (OCT-268) pages the member's points history newest first:
`limit` 1–100 (default 25) and `cursor`, the last row's id from the previous page, returning
`{items,nextCursor}`. Pages are keyed on (`created_at`, `id`) and the database compares against the
cursor row's own timestamp, so rows sharing a timestamp are neither skipped nor repeated. Each row
carries its status (PENDING until the chain confirms it; an unconfirmed earn shows `estimatedPoints`,
not `pointsAmount`). A cursor that is not one of this member's rows is a 400.
GET `/:memberId/vouchers` lists every voucher the member holds with its ownership status, the same
shape as the API-key `GET /v1/rewards/members/:memberId/vouchers`. Both are Owner or Developer reads;
another organization's member is a 404.

PATCH `/:memberId` accepts status, externalMemberId (null clears), and tenant
metadata. It cannot change global customer identity, staff roles, organization, or balance.
External IDs are bound after enrollment; the existing per-organization unique constraint
returns 409 on collisions. Tier membership is outside this delivery (OCT-255 and subissues). The pre-existing
enrollment tier column and stored values are preserved, but directory responses,
filters and mutation contracts do not expose or change them.

New earn and POS reserve acceptance lock organization/enrollment/global-customer eligibility
before holding points or recording operations. Blocked customers cannot create new work;
voucher claim/redeem already enforce the same status rule. Previously accepted work can
still settle/reconcile so blocking cannot strand holds or contradict a chain result.
Replaying an existing earn idempotency key does not create new work.

Web reuses the Business Members route and offers a read-only Developer Members route.
There is no manual enrollment, global user editing, or direct points adjustment here.
