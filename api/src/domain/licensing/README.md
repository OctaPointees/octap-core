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
- **State** is worked out from the dates (`license-state.ts`), never stored: `ACTIVE` before
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
organization that has none. Usage counts confirmed `EARN` and `REDEEM` transactions in the current
license month, members, ACTIVE API keys and ACTIVE Owners and Business Developers.

## Not yet

Nothing is enforced in this part: no 402, no usage counter, no warnings or expiry reminders (OCT-329
parts 2–3), and no buying or renewing (OCT-330).
