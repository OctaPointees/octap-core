# Licenses (OCT-329)

What an organization may use, and until when. Separate from points: a license never touches
customers' balances, vouchers or reversals.

## Model

- **`license_plans`**: the catalogue the System Admin manages. One row per tier (`TRIAL`, `STARTER`,
  `GROWTH`, `ENTERPRISE`): `monthlyPriceVnd` (an integer), the terms it is sold for
  (`termMonthsAllowed`), a fixed `durationDays` for the trial, and `entitlements`:
  `features` (`voucher.batches`, `voucher.approval`, `webhooks`, `mcp`, `assistant`, `sandbox`) and
  `limits` (`transactionsMonthly`, `members`, `apiKeys`, `teamMembers`; `null` is no limit). A plan
  is never deleted, only made inactive. `purchasable` plans need at least one term.
- **`licenses`**: one organization's copy of a plan's entitlements from `starts_at` to `ends_at`,
  with how it came about (`TRIAL`, `MIGRATION`, `PURCHASE`, `ADMIN`). Editing a plan never changes a
  license already granted. The current license is the latest that has started.
- **State** is worked out from the dates (`infra/db/repositories/license-period.ts`), never stored: `ACTIVE` before
  `ends_at`, `GRACE` for `LICENSE_GRACE_DAYS` (7) after it, then `EXPIRED`.
- **License month**: usage resets every month from `starts_at`, not on the calendar month
  (`licensePeriod`; 31 January plus a month is the last day of February).

## Where licenses come from

- Migration `0038_licensing` seeds the four plans (sample prices and limits) and gives every
  organization that isn't `ARCHIVED` a free Growth license for 12 months.
- Approving a `CREATE_ORGANIZATION` request grants the trial in the same transaction
  (`grantTrialLicense`). Without an active trial plan nothing is granted.

## Routes

| Route | Who |
| --- | --- |
| `GET /v1/console/organizations/:organizationId/license` | Owner, Business Developer (403 otherwise) |
| `GET /v1/console/license-plans` | Any signed-in console user: the active, purchasable plans |
| `GET /v1/license` | API key with `read` |
| `GET`, `POST /v1/platform/license-plans`; `PATCH …/:id` | System Admin |
| `GET /v1/platform/organizations/:organizationId/license` | System Admin |

The license response is `{ organizationId, license, usage }`; `license` and `usage` are `null` for an
organization that has none. Usage counts the transactions accepted in the current license month (the
`license_usage` counter below), members, ACTIVE API keys and ACTIVE Owners and Business Developers.

## Enforcement (part 2)

All of it lives in `infra/db/repositories/license-enforcement.ts`, inside the caller's transaction.
An organization without a license is never limited. Refusals answer **402** with
`{ statusCode, code, message, ... }`:

- `LICENSE_LIMIT_REACHED` (`limit`, `used`, `allowed`): a limit is full.
- `LICENSE_FEATURE_NOT_INCLUDED` (`feature`): the license lacks a feature.

**Transactions.** `license_usage` keeps one row per license and license month. Earn, POS reserve and
a paid voucher claim each take one with a single conditional `UPDATE … WHERE transactions < hard
limit`, so concurrent requests can't pass it; the hard limit is 110% of the plan's limit. A
transaction that fails on chain (earn, POS) or a POS hold that expires gives its count back to the
month it was accepted in. A replay under the same idempotency key takes nothing. Crossing 80% and
100% records `license.usage_threshold` once per month each (webhook + console events, subject
`{ kind: 'license' }`).

**Resources.** Members (a new enrollment), active API keys (sandbox ones too) and the team (Owners
and Business Developers: inviting, accepting, restoring a suspended one) stop at exactly 100%.
`requireLicenseCapacity` locks the license row before counting, so two adds racing for the last
place queue up.

**Features.** `@RequiresFeature(feature)` with `LicenseFeatureGuard` on a route, checked after the
caller is known to belong to the organization (an outsider still gets its 403):

| Feature | Where |
| --- | --- |
| `webhooks` | registering and re-enabling an endpoint |
| `voucher.batches` | creating and activating a batch (console and API key) |
| `assistant` | assistant messages, and each use of the assistant's token |
| `mcp` | issuing an MCP code, and each use of an MCP token |
| `voucher.approval` | turning the setting on (turning it off always works) |
| `sandbox` | every request with a sandbox key |

What already exists keeps working (endpoints, batches, pending approvals); only new uses are refused.

## Not yet

Expiry (blocking once EXPIRED) and reminders (OCT-329 part 3), and buying or renewing (OCT-330).
