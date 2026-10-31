# Webhooks domain

Signed event delivery to merchant-registered endpoints.

- `webhook-endpoints.service.ts`: register/list/enable/disable/rotate-secret. The raw secret is
  only ever returned on register or rotate; it's stored as plaintext in Postgres because the
  server must recompute the HMAC at send time — needs a secrets manager/KMS before production.
- `webhook-delivery.service.ts`: `emit()` fans an event out to every ACTIVE endpoint (best-effort,
  not atomic with the triggering transaction — see `docs/roadmap.md`); `replay()` re-queues a
  DEAD_LETTER delivery without changing its id.
- `webhook-delivery.worker.ts` / `.processor.ts`: polls due deliveries, signs the exact request
  body with the endpoint's secret, POSTs it, and retries with backoff up to `MAX_DELIVERY_ATTEMPTS`
  before dead-lettering. Registered only in `api/src/worker.module.ts`, same rule as every worker.
- `webhook-signing.util.ts`: HMAC-SHA256 signing/verification shared by the processor and tests.
  `ts-sdks/packages/node/src/webhooks.ts` has the receiver-side equivalent for merchants.

Persistence is `infra/db/repositories/webhooks.repository.ts`; HTTP is
`api/rest/webhooks.controller.ts`.

Events (types in `@octap/contracts`' `WebhookEvent`):

| Event | When | Sent by |
| --- | --- | --- |
| `credits.earned` | an earn is accepted (still PENDING on-chain) | `EarnService`, via `emit()` |
| `credits.redeemed` | a voucher-claim debit (ledger-only, no chain step) | `RedemptionService`, via `emit()` |
| `credits.earn.confirmed` | the chain confirmed an earn | `CreditsRepository.confirmEarnOnChain` |
| `credits.redemption.confirmed` | the chain confirmed a POS redemption | `CreditsRepository.confirmPosRedemptionOnChain` |
| `credits.reversed` | a CONFIRMED earn or redemption was reversed in the ledger (not on a replayed key) | `CreditsRepository.recordReversalTransaction` |
| `voucher.redeemed` | a claimed voucher instance was used | `RewardsRepository.redeemVoucher` |

The two `*.confirmed` events are queued with `enqueueWebhookEvent(tx, ...)` inside the confirm's
own transaction (OCT-209): they commit or roll back with it, and only the caller that wins the
PENDING guard reaches them, so a transaction gets exactly one whether the chain-submit worker,
POS finalize, `ChainOutcomeReconciler` or the indexer confirmed it. `credits.reversed` and
`voucher.redeemed` use the same outbox form (OCT-244): queued in the reversal's transaction, and
with the conditional `AVAILABLE -> REDEEMED` update, so a losing concurrent redeem queues nothing.
The `emit()` events (`credits.earned`, `credits.redeemed`) are best-effort relative to their write
(see the roadmap).
