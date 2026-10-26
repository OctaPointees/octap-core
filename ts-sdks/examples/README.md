# Node SDK voucher demo

Run a prepared member through **balance → claim a reward with points → redeem the voucher → verify persisted state** using the public `@octap/sdk` package. This is a merchant-server example; never put its API key into browser code.

## Run the self-contained local demo

Start Docker Desktop, then run from `octap-core` with Node `>=24.15 <25`:

```powershell
npm ci
npm run demo:sdk:local
```

This builds the workspace, starts fresh disposable PostgreSQL/Redis containers, applies migrations, seeds a synthetic 100-point member and a private merchant credential, and boots the real Nest API on an available local port. It creates a 25-point reward through the public SDK, runs the full demo, verifies claim replay and duplicate redemption behavior, and closes the API and containers afterward. No existing database, `.env` credentials, chain wallet, worker or external identity service is required. The synthetic balance is an explicit database-only demo fixture.

Expected result: **100 → 75 points**, one redeemed voucher, the original result on claim replay, and a rejected second redemption. This is real HTTP/API/PostgreSQL verification; it does not test Sui or Google login.

## Prepare an existing development API

- Use Node `>=24.15 <25` and run `npm ci` and `npm run build` from `octap-core`.
- Start PostgreSQL/Redis, apply migrations and start Core using the root README. Start the worker/indexer if the member's initial points still need chain confirmation.
- Prepare an enrolled member and an active, in-stock voucher in the **same organization as the API credential**. The member must not already own that voucher.
- Give the member enough settled confirmed points for the voucher's positive points cost. The demo does not enroll users, provision organizations, issue points or create rewards.
- Use a development credential with `read` and `write` scopes. `node scripts/seed-dev-credential.mjs <organization-id> "sdk-demo"` can prepare a local credential; keep the returned key private.

## Run in PowerShell

```powershell
$env:OCTAP_API_URL = 'http://127.0.0.1:3000'
$env:OCTAP_API_KEY = '<development merchant key>'
$env:OCTAP_DEMO_MEMBER_ID = '<organization-end-user UUID, not global end-user UUID>'
$env:OCTAP_DEMO_VOUCHER_ID = '<active voucher UUID>'
$env:OCTAP_DEMO_RUN_ID = 'voucher-demo-001'
npm run demo:sdk
```

The command uses built workspace package exports. Rebuild after changing the SDK. Each request has a 15-second timeout; errors produce a nonzero exit code. Configuration does not automatically load `.env`.

Expected output for a 100-point balance and 25-point reward ends with:

```text
Verified: 100 → 75 points; voucher REDEEMED.
```

The script also verifies the owned voucher's persisted status and the matching confirmed points transaction through SDK reads. Use a quiet, dedicated demo member: concurrent balance changes or more than 50 newer transactions can make verification fail.

## Failures and repeat runs

The demo spends points and consumes a real voucher in the configured development environment. Preflight reads reject unsettled balances, insufficient funds, unavailable rewards and existing ownership before claiming. These checks do not replace server-side concurrency protection.

Mutations are sent once, without automatic retries. Keep the run ID tied to one member/voucher attempt; never generate a new ID just to retry an uncertain claim. On this branch, Core commits deduction and ownership together and returns the original result when the same claim key and payload are replayed. Changed payloads return 409. After any uncertain mutation, inspect `getBalance`, `listMemberVouchers` and `listTransactions` before proceeding. Do not assume that a failed request means no mutation occurred, particularly against older Core deployments.

The ownership ID and serial are printed immediately after claiming so a failed redemption can be investigated without claiming again. A rerun with the same member/voucher stops when ownership exists. For a new demonstration, prepare a different voucher or member and use a new run ID.

Voucher conversion currently debits PostgreSQL; customer-signed Sui POS redemption is a separate flow. This example does not claim chain confirmation or resolve ledger reconciliation. It covers the runnable demo slice of OCT-239, not the remaining management APIs or SDK operation polling.

## Verify the example

```powershell
npm run test:demo:sdk
```

These tests exercise the real public SDK against a local HTTP fixture. They verify orchestration and failure behavior; they do not verify a live Core database or chain.

CI runs both these regressions and the self-contained live API/database demo after building the SDK. Cleanup attempts every resource even if an earlier close fails.

Run database/API race and lifecycle regressions with Docker available:

```powershell
npm run test:integration -- api/tests/integration/repositories/rewards.repository.integration.test.ts api/tests/integration/http/rewards.integration.test.ts
```

The merchant SDK also exposes `updateVoucher(id, patch)` for reward edits and activation/pausing. It uses the same PATCH API and runtime validation described in the [rewards domain guide](../../api/src/domain/rewards/README.md).
