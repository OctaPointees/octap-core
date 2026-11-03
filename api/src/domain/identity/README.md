# Identity domain

Google-based zkLogin via Enoki: resolves a real Sui address for an end user, and builds the
sponsored on-chain transaction boundary redemption will sign.

- `identity.service.ts`: `loginWithGoogle()` resolves a Google id_token to a zkLogin Sui address
  through Enoki (which validates the token itself — this process never verifies a Google JWT on
  its own) and binds it to a global `end_users` row. `enrollInOrganization()` idempotently joins
  the end user its id_token proves to one organization's loyalty program
  (`organization_end_users`); it never accepts an end-user id from the caller. `verifyCustomer()`
  is the merchant backend's read-only check of the same token, behind the API-key guard. Enrollment
  refuses an organization that is not ACTIVE and a customer who is not ACTIVE. Also proxies
  `createZkLoginNonce`/`createZkLoginProof` so a frontend never needs its own Enoki credential.
- `sponsored-transaction.service.ts`: `previewSponsoredRedeem()` builds `credit_account::redeem`'s
  transaction kind (via `infra/clients/sui/sui-transaction-builder.client.ts`, which holds no
  signer) and asks Enoki to sponsor gas for it, scoped to that one Move call target. Returns bytes
  for the end user to zkLogin-sign; does not execute anything or touch credits/ownership state —
  that bookkeeping is OCT-55 ("Complete Customer-Signed POS Redemption"), which calls this service
  rather than duplicating it. Not yet wired to a controller for the same reason: there is no
  lookup yet from an `organizationEndUserId` to a Sui `CreditAccount` id, since that join is part
  of OCT-55's scope.

There is no password and no bearer session issued by login: a sensitive action (redeem) is
authorized by the end user's own zkLogin signature on that specific transaction, not by a token
this domain hands out. Reads that still need a caller identity (balance, voucher history) remain
behind the existing API-key tenant guard until a real customer-session mechanism is separately
scoped — this domain does not invent one.

Persistence is `infra/db/repositories/identity.repository.ts`; HTTP is
`api/rest/identity.controller.ts`: `IdentityController` is deliberately not behind
`@Tenant()`/`@Scopes()` since the caller never holds a merchant API credential, and is limited per
client IP instead; `CustomerVerificationController` takes the organization from the API key. Vendor access is
`infra/clients/enoki/enoki.client.ts` (`ENOKI_API_KEY`, safe in the HTTP process — it's an app
credential, not a signer key) and `infra/clients/sui/sui-transaction-builder.client.ts` (no key at
all, separate from the worker-only `SuiClientService`).
