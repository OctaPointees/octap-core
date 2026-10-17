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
`api/rest/webhooks.controller.ts`. Only `EarnService`/`RedemptionService` call `emit()` today;
`ReversalService`/`RewardsService` don't yet (see the roadmap).
