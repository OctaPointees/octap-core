# Customer membership directory (OCT-71)

Google-authenticated console routes under `/v1/console/organizations/:organizationId/members`
read organization customer enrollments, not organization staff. Active Owner/Developer
membership in an ACTIVE organization is required; only Owners can PATCH a customer profile.
SYSTEM_ADMIN alone grants no tenant access. All database operations recheck permissions
inside a transaction and constrain every enrollment query by organization ID.

GET list supports `limit` 1–100 (default 25), UUID `cursor`, text `q`, exact `tier`,
`status=ACTIVE|BLOCKED` and exact `externalMemberId`. Results use ascending enrollment UUID
and return `{items,nextCursor}`. `q` searches display name/email/phone/external ID with
literal wildcard escaping. GET `/:memberId` adds the current CreditsService balance,
including pending amounts, expiry handling, observation/checkpoint and stale indicators.

PATCH `/:memberId` accepts tier, status, externalMemberId (null clears), and tenant
metadata. It cannot change global customer identity, staff roles, organization, or balance.
External IDs are bound after enrollment; the existing per-organization unique constraint
returns 409 on collisions. Tier labels use the existing enrollment field; configurable
tier rules/evaluation remain the membership-tier tickets, not this directory.

New earn and POS reserve acceptance lock organization/enrollment/global-customer eligibility
before holding points or recording operations. Blocked customers cannot create new work;
voucher claim/redeem already enforce the same status rule. Previously accepted work can
still settle/reconcile so blocking cannot strand holds or contradict a chain result.
Replaying an existing earn idempotency key does not create new work.

Web reuses the Business Members route and offers a read-only Developer Members route.
There is no manual enrollment, global user editing, or direct points adjustment here.
