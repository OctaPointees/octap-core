# Webhooks domain

Signed event delivery to merchant-registered endpoints.

- `webhook-endpoints.service.ts`: register/list/enable/disable/rotate-secret. The raw secret is
  only ever returned on register or rotate; it's stored as plaintext in Postgres because the
  server must recompute the HMAC at send time — needs a secrets manager/KMS before production.
- `webhook-delivery.service.ts`: lists deliveries; `replay()` re-queues a DEAD_LETTER delivery
  without changing its id or its event's id.
- `webhook-delivery.worker.ts` / `.processor.ts`: polls due deliveries, signs the exact request
  body with the endpoint's secret, POSTs it, and retries with backoff up to `MAX_DELIVERY_ATTEMPTS`
  before dead-lettering. Registered only in `api/src/worker.module.ts`, same rule as every worker.
- `webhook-signing.util.ts`: HMAC-SHA256 signing/verification shared by the processor and tests.
  `ts-sdks/packages/node/src/webhooks.ts` has the receiver-side equivalent for merchants.

- `console-webhooks.service.ts`: the Owner's console routes (register, list, disable, enable,
  rotate-secret, list deliveries, replay), each inside the Owner check's transaction. Owner only,
  reads included; a Business Developer is a 403 (OCT-301).

Persistence is `infra/db/repositories/webhooks.repository.ts`; HTTP is
`api/rest/console-webhooks.controller.ts` (the Owner manages endpoints) and
`api/rest/webhooks.controller.ts` (a `read` API key lists endpoints and deliveries; no key changes them).

## The outbox: `organization_events` (OCT-325)

Every event is one row in `organization_events`, written by `recordEvent(tx, ...)`
(`infra/db/repositories/events.repository.ts`) inside the transaction of the change it describes,
so it commits or rolls back with that change. It is written whether or not the organization has an
endpoint, then queued as one `webhook_deliveries` row per ACTIVE endpoint in the same transaction.
Nothing is ever emitted after a commit, so no event is lost to a crash between the two.

- The event's `id` is the body's `id` and `x-octap-event-id`: the same for every endpoint, and kept
  across retries and replays. A delivery's own `id` only names that delivery (replay, the list).
- `sequence` orders an organization's events for a reader that resumes from the last one it saw
  (the console stream, OCT-326). It is assigned at insert, not commit: don't assume a lower one has
  always committed first.
- `recordEvent` is typed by event: the payload must be that type's `data` from `@octap/contracts`.
- Events are kept 30 days (`EventRetentionWorker`, OCT-326), except one still owed to an endpoint
  (PENDING) or that the Owner may replay (DEAD_LETTER). Deleting an event deletes its deliveries, so
  the delivery list shows the last 30 days.
- The console event stream reads the same table (see `domain/events/README.md`).
- Each caller records only on the path that made the change (a guarded conditional update, a new
  key), so a retry or a lost race records nothing.

Events (types in `@octap/contracts`' `WebhookEvent`):

| Event | When | Sent by |
| --- | --- | --- |
| `credits.earned` | an earn is accepted (still PENDING on-chain), not on a retried key | `CreditsRepository.recordEarnTransaction` |
| `credits.earn.confirmed` | the chain confirmed an earn | `CreditsRepository.confirmEarnOnChain` |
| `credits.earn.failed` | an accepted earn definitely failed | `CreditsRepository.failEarnOnChain` |
| `budget.low` | the fullest budget shard crossed 80% or 95% used | `ProgramsRepository.recordBudgetWarning` |
| `credits.redemption.confirmed` | the chain confirmed a POS redemption | `CreditsRepository.confirmPosRedemptionOnChain` |
| `credits.reversed` | a CONFIRMED earn or redemption was reversed in the ledger (not on a replayed key) | `CreditsRepository.recordReversalTransaction` |
| `voucher.granted` | the chain recorded a grant or free claim | `RewardsRepository.confirmVoucherGrant` |
| `voucher.redeemed` | the chain recorded a customer-signed use | `RewardsRepository.confirmVoucherUse` |
| `voucher.created` | a voucher is created, alone or by a batch, or an archived code is imported again | `createVoucher`, `createVoucherBatch` |
| `voucher.submitted` | an activation waits for an Owner (approval required) | `RewardsRepository.queueApproval` |
| `voucher.returned` | a submission was rejected or withdrawn; back to DRAFT | `RewardsRepository.decide` |
| `voucher.activated` | ACTIVE: the chain confirmed its terms, or a paused one was resumed | `setPublished`, `updateVoucher` |
| `voucher.publish.failed` | its terms never reached the chain | `RewardsRepository.failVoucherPublish` |
| `voucher.paused` | an Owner or an API key paused it | `RewardsRepository.updateVoucher` |
| `voucher.archived` | its batch was archived before it went live | `RewardsRepository.archiveVoucherBatch` |

Voucher lifecycle events carry the voucher as it is right after the change (`VoucherLifecycleEventData`:
`status` including `ARCHIVED`, `publishStatus`, `createdBy`, `activatedBy`, `updatedAt`). An approval
sends nothing of its own: it starts publishing, and `voucher.activated` or `voucher.publish.failed`
follows. A voucher paused while publishing stays paused when the chain confirms it, so it sends
`voucher.activated` only when resumed. Archiving a voucher that waits for approval sends
`voucher.archived`, not `voucher.returned`. Running out of supply (`DEPLETED`) and expiry send nothing.

The two `*.confirmed` events are recorded inside the confirm's own transaction (OCT-209), and only
the caller that wins the PENDING guard reaches them, so a transaction gets exactly one whether the
chain-submit worker, POS finalize, `ChainOutcomeReconciler` or the indexer confirmed it.
`credits.reversed` and `voucher.redeemed` follow the same rule (OCT-244), the latter behind the
conditional `AVAILABLE -> REDEEMED` update, so a losing concurrent redeem records nothing.

`credits.earned.data` carries `purchaseAmount` and `estimatedPoints`, not `pointsAmount`.
The confirmed event carries the actual `pointsAmount`.
