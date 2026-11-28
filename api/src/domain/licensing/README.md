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

- Migration `0044_licensing` (all of OCT-329: plans, licenses, the usage counter and the expiry notice column) seeds the four plans (sample prices and limits) and gives every
  `ACTIVE` or `SUSPENDED` organization a free Growth license for 12 months. One waiting for approval
  gets the trial when it is approved.
- Approving a `CREATE_ORGANIZATION` request grants the trial in the same transaction
  (`grantTrialLicense`), from the newest active trial plan. An organization that already has a license
  keeps it and gets no trial; without an active trial plan nothing is granted. Every license is
  written by `insertLicense`, which copies the plan's entitlements.

## Routes

| Route | Who |
| --- | --- |
| `GET /v1/console/organizations/:organizationId/license` | Owner, Business Developer (403 otherwise) |
| `GET /v1/console/license-plans` | Any signed-in console user: the active, purchasable plans |
| `GET /v1/license` | API key with `read` |
| `GET`, `POST /v1/platform/license-plans`; `PATCH …/:id` | System Admin |
| `GET`, `POST /v1/platform/organizations/:organizationId/license` | System Admin (404 for an unknown organization; `POST`: renew, below) |

The license response is `{ organizationId, license, usage }`; `license` and `usage` are `null` for an
organization that has none. Usage counts the transactions accepted in the current license month (the
`license_usage` counter below), ACTIVE members who aren't blocked or unverified, ACTIVE API keys and
ACTIVE Owners and Business Developers. The license month is counted from `starts_at`; the last one
ends at `ends_at`, and once that has passed it stays the last month instead of rolling on.

## Enforcement (part 2)

All of it lives in `infra/db/repositories/license-enforcement.ts`, inside the caller's transaction.
An organization without a license is never limited. Refusals answer **402** with
`{ statusCode, code, message, ... }`:

- `LICENSE_LIMIT_REACHED` (`limit`, `used`, `allowed`): a limit is full.
- `LICENSE_FEATURE_NOT_INCLUDED` (`feature`): the license lacks a feature.
- `LICENSE_EXPIRED`: the license is past its grace period (part 3, below).

**Transactions.** `license_usage` keeps one row per license and license month. Earn, POS reserve and
a paid voucher claim each take one with a single conditional `UPDATE … WHERE transactions < hard
limit`, so concurrent requests can't pass it; the hard limit is 110% of the plan's limit. A
transaction that fails on chain (earn, POS) or a POS hold that expires gives its count back to the
month it was accepted in. A replay under the same idempotency key takes nothing. Crossing 80% and
100% records `license.usage_threshold` once per month each (webhook + console events, subject
`{ kind: 'license' }`).

**Resources.** Members (a new enrollment, counting active members who aren't blocked or unverified), active API keys (sandbox ones too) and the team (Owners
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

## Expiry and renewal (part 3)

**Expired.** Once a license is past `endsAt` plus the 7-day grace, `takeLicenseTransaction` refuses
new transactions (earn, POS reserve, paid voucher claims) with 402 `LICENSE_EXPIRED`. That is the
only thing an expired license stops: confirmations and failures from the chain, reversals, POS
finalize, balances, free claims and vouchers customers already hold never pass through it, and the
features and other limits stay those of the last license. During the grace period nothing is
refused.

**Notices.** `LicenseExpiryWorker` (worker process, at start and every
`LICENSE_EXPIRY_POLL_INTERVAL_MS`, 15 minutes) calls `LicensesRepository.recordExpiryNotices`,
which records `license.expiry_notice` (webhook + console events, subject `{ kind: 'license' }`) for
each organization's **latest** license at the step it has reached, worked out by
`licenseExpiryStage`:

| `stage` | When |
| --- | --- |
| `DAYS_30`, `DAYS_7`, `DAYS_1` | that many days before `endsAt`; skipped when the license is shorter (a 14-day trial gets 7 and 1) |
| `GRACE` | `endsAt` has passed |
| `EXPIRED` | the grace period is over |

`licenses.expiry_notice_stage` keeps the last step sent and only moves forward, with a conditional
update in the event's transaction (the enum's order is the step order). So a step is sent once even
with several workers. When steps passed unseen, only the current one is sent. A license that has a
later one (it was renewed) sends nothing more. Archived organizations are skipped. The pass reads
across organizations: an RLS exception, like the outbox trim.

**Renewal.** `LicensesRepository.renew` grants `months` of a plan as a new license. It follows the
latest license from its `endsAt` while that is active or in grace, and starts now once it has
expired (`renewalStart`). Renewing early or during grace loses no day. Example, 3 months on a
license ending 1 December: renewed on 28 November or 5 December, the new one runs 1 December to
1 March; renewed on 20 December, 20 December to 20 March. The organization row is locked first, so
two renewals at once follow each other instead of overlapping. Each license keeps the entitlements
of its plan when granted and its own monthly counter.

`POST /v1/platform/organizations/:organizationId/license` `{ planId, months }` (System Admin,
`source: ADMIN`, an active plan that isn't the trial, 1–36 months) is the way to renew or upgrade
until payments exist. It answers the organization's license as it then stands.

## Orders (OCT-330, part 1)

An Owner buys or renews by placing an order; the money comes by bank transfer, which SePay reports
(part 2). `license_orders` (RLS) holds:

- `amount_vnd`: the plan's `monthly_price_vnd` × `term_months`, worked out on the server. The body
  is `{ planId, termMonths }` only; any other field, an amount included, is a 400.
- `payment_code`: `OCTAP` and 8 random digits, unique across every organization, so a transfer's
  content finds its order. A clash draws again.
- `status`: `PENDING`, `PAID` or `CANCELED`. An order can be paid for 24 hours; after that a
  `PENDING` one reads as `EXPIRED`, worked out from `expires_at` and never stored.

One order waits to be paid at a time. Placing the same plan and term again returns it; anything
else cancels it first, so an old QR code can't be paid by mistake. Both run with the organization's
row locked FOR UPDATE (the Owner check), so two orders placed at once queue up.

Each order carries its VietQR image, `https://qr.sepay.vn/img?acc=…&bank=…&amount=…&des=<code>`,
built from `SEPAY_BANK_ACCOUNT` and `SEPAY_BANK_CODE`. Until both are set, the routes answer 503.

| Route | Who |
| --- | --- |
| `POST /v1/console/organizations/:organizationId/license/orders` | Owner of an ACTIVE organization; the plan active and purchasable, `termMonths` one of its terms |
| `GET …/license/orders`, `GET …/orders/:orderId` | Owner; another organization's order is a 404 |
| `POST …/orders/:orderId/cancel` | Owner; a PENDING order (expired or not), else 409 |

## Not yet

Receiving the money (the SePay webhook) and reconciliation (OCT-330 parts 2–3); the console
screens (OCT-331/332).
