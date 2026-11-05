# Worker signers on AWS KMS

The worker signs Sui transactions with two keys: the **issuer** key (holds every program's
`IssuerCap`; signs `open_account`, `earn`, reversals) and the **program admin** key (holds each
program's `AdminCap`; signs provisioning and budget top-ups). This page covers how those keys
live in AWS KMS: what was decided, how they were provisioned, how a developer or a deployed
worker gets access, and what each signature costs.

Code: [`api/src/infra/clients/sui/signer.ts`](../api/src/infra/clients/sui/signer.ts). Setup:
[`scripts/setup-kms-signers.mjs`](../scripts/setup-kms-signers.mjs). Smoke test and latency
check: [`scripts/check-kms-signer.mjs`](../scripts/check-kms-signer.mjs).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Provider | AWS KMS | Team choice (OCT-245). The private key never leaves KMS; the worker holds only a key reference and calls `kms:Sign`. |
| Signer code | Mysten's `@mysten/aws-kms-signer`, not a hand-rolled `@aws-sdk/client-kms` adapter | Mysten maintains it next to `@mysten/sui`. It reads the scheme from the key's `KeySpec`, and it handles DER decoding and secp256k1 low-S normalization (the pieces Harbor wrote by hand for GCP). It accepts any AWS credential provider, so we pass the AWS SDK's own `defaultProvider()` chain. Retries KMS 5xx/429 with backoff. |
| Key spec | `ECC_NIST_EDWARDS25519` (Ed25519, `ED25519_SHA_512`) | Same scheme as the existing Sui keys. Ed25519 has none of ECDSA's signature malleability, so there is no low-S step. `ECC_SECG_P256K1` (what Harbor uses on GCP) also works unchanged, because the scheme comes from the key. |
| Testnet key material | **Imported** (`Origin=EXTERNAL`) from the existing raw keys | Keeps both Sui addresses, and with them every `IssuerCap`, `AdminCap` and the package `UpgradeCap` already on testnet: no cap transfers, no re-provisioning. The cost is that the key material existed outside KMS once; the raw keys stay as an offline backup held only by the signer manager (below). |
| Mainnet key material | KMS-generated (`Origin=AWS_KMS`) | A mainnet key should never have existed outside KMS. New keys mean new addresses, which mainnet starts with anyway. |
| One key or two | **Two keys**, `alias/octap-testnet-issuer` and `alias/octap-testnet-program-admin` | The blast radii differ: an `AdminCap` can mint `IssuerCap`s and rotate policy. Two keys let a hosted worker hold `kms:Sign` on the issuer key only (one role per key, below). |
| Who can sign | One shared signer identity for the dev team, the IAM user `octap-testnet-signer` | Harbor's model: one GCP service account with `cloudkms.signerVerifier` on a dev key ring, its credential handed to developers. Here the user can call `kms:Sign` and `kms:GetPublicKey` on the two keys and nothing else in AWS. Revoking it is deleting its access key. A developer gets signing, never the key. |
| Credentials | AWS SDK default chain (`@aws-sdk/credential-provider-node`) | The same code works everywhere: a named profile on a laptop (access key, `aws login`, SSO, assume-role), env keys on a non-AWS host, a task role/pod identity/instance profile on AWS compute. |
| Raw keys | Local fallback only, refused on mainnet | When `SUI_*_KMS_KEY_ID` is unset, `SUI_*_PRIVATE_KEY` still works, with a warning. On `SUI_NETWORK=mainnet` the worker refuses a raw key: mainnet signs through KMS or not at all (Harbor's "production requires KMS" guard). |
| Region | `ap-southeast-2` (Sydney) | The AWS project the keys live in is limited to one region until advanced features are on. A key ARN carries its own region, so moving later only changes config. |

## Environment

| Variable | Value | Notes |
| --- | --- | --- |
| `SUI_ISSUER_KMS_KEY_ID` | `alias/octap-testnet-issuer` | Key id, key ARN, alias name, or alias ARN. |
| `SUI_PROGRAM_ADMIN_KMS_KEY_ID` | `alias/octap-testnet-program-admin` | Same forms. |
| `AWS_REGION` | `ap-southeast-2` | Needed unless the key id is an ARN. |
| `AWS_PROFILE` | `octap-testnet-signer` | Or any other source the default chain reads. **Never** put access keys in `.env`. |

None of these are secrets. The public key is fetched once per process, on first use
(`GetPublicKey`). Each transaction then costs exactly one `Sign` call. A failed load (throttling,
expired credentials) is not cached, so the next attempt retries it.

## What exists (testnet)

AWS account `967307910342`, region `ap-southeast-2`, everything tagged `project=octap, env=testnet`:

| Resource | Name | Signs as / can do |
| --- | --- | --- |
| KMS key (imported Ed25519) | `alias/octap-testnet-issuer` | `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` |
| KMS key (imported Ed25519) | `alias/octap-testnet-program-admin` | `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` (also the deploy wallet holding the `UpgradeCap`) |
| IAM user | `octap-testnet-signer` | `kms:Sign` + `kms:GetPublicKey` on both keys |
| IAM role | `OctapTestnetIssuerSigner` | `kms:Sign` + `kms:GetPublicKey` on the issuer key, for a worker on AWS compute |
| IAM role | `OctapTestnetProgramAdmin` | `kms:Sign` + `kms:GetPublicKey` on the admin key, `kms:GetPublicKey` on the issuer key |

The **signer manager** (one person) owns this: they hold the offline raw-key backup, issue and
revoke `octap-testnet-signer` access keys, and keep both addresses funded with testnet SUI.
Funding needs no key: send SUI to the addresses above from the faucet or any wallet.

## Provisioning (signer manager, once per environment)

From the repo root, signed in to the AWS CLI as an identity that can manage KMS and IAM, with
the raw keys to import in `.env`:

```bash
AWS_PROFILE=<admin profile> node --env-file=.env scripts/setup-kms-signers.mjs
```

For each signer the script creates an `Origin=EXTERNAL` Ed25519 key and its alias, fetches an
RSA-4096 wrapping key and import token, wraps the raw key (PKCS#8) under RSAES-OAEP-SHA-256 in
memory, imports it with no expiry, and checks that the address KMS now signs as is the raw key's
address. It then creates or updates the signer user and the two roles. Re-running only verifies.
The default key policy (delegate to IAM) is kept, so the IAM policies are the whole grant.

Then issue the team credential:

```bash
aws iam create-access-key --user-name octap-testnet-signer
```

AWS shows the secret once. Hand it to each developer privately (never in chat history, a repo or
`.env`). When someone leaves or the key may have leaked: create a new access key, hand it out,
then `aws iam delete-access-key` the old one. Signing stops for the old key immediately.

Finally, remove `SUI_ISSUER_PRIVATE_KEY` and `SUI_PROGRAM_ADMIN_PRIVATE_KEY` from every `.env`
and keep one offline backup (a password manager entry the signer manager alone can open). With
imported material, that backup is the only way back if a KMS key is ever deleted.

## Developer setup (each teammate, once)

```bash
aws configure --profile octap-testnet-signer   # the access key from the signer manager; region ap-southeast-2
```

In `.env`:

```dotenv
AWS_REGION=ap-southeast-2
AWS_PROFILE=octap-testnet-signer
SUI_ISSUER_KMS_KEY_ID=alias/octap-testnet-issuer
SUI_PROGRAM_ADMIN_KMS_KEY_ID=alias/octap-testnet-program-admin
SUI_ISSUER_PRIVATE_KEY=
SUI_PROGRAM_ADMIN_PRIVATE_KEY=
```

Then everything runs as before:

```bash
node --env-file=.env api/dist/worker.js
node --env-file=.env scripts/provision-program.mjs <orgId> 500 365 1000000
node --env-file=.env scripts/check-kms-signer.mjs both 20   # smoke + latency
```

A member of the AWS project can skip the access key: `aws login --profile octap-dev` and
`AWS_PROFILE=octap-dev` work too, signing under their own identity.

## The deployed testnet/staging worker

The testnet deployment is also the staging environment real users touch, so it gets the
production shape wherever the host allows:

- **On AWS compute** (ECS/Fargate, EKS, EC2): use `OctapTestnetIssuerSigner` as the task role,
  pod identity or instance profile. Don't set any AWS key variables; the default chain picks up
  the role. This is the target shape for mainnet too.
- **On a non-AWS host**: create a dedicated IAM user `octap-testnet-worker` with only the issuer
  role's policy (never the admin key), and store its access key in the host's secret store as
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Don't reuse the team's signer key there.
  Provisioning can also run from the dedicated organization worker when
  `ORG_PROVISION_WORKER_ENABLED=true`. That worker needs signing access to both the
  program-admin key and the issuer key; isolate its IAM permissions from an issuer-only
  earn worker. The HTTP API holds neither signing permission. Top-ups remain an operator action.

## Latency and cost

- **Per transaction**: one `Sign` round trip to KMS, added to the build → sign → execute → wait
  path. Measure it with `scripts/check-kms-signer.mjs`, and record the numbers below whenever the
  key location or the deployment changes.
- **Per process**: one `GetPublicKey` plus a credential resolution on first use, then cached.
- **CI and the test suite: zero KMS calls.** Unit tests point the real `AwsKmsSigner` at a fake
  KMS endpoint that signs with a local key (`api/tests/unit/infra/clients/signer.test.ts`).
  `api/tests/setup.ts` deletes `SUI_*_KMS_KEY_ID`, so a developer's shell can't leak a real key
  into a test run. Chain calls stay faked, as before.
- **Money**: $1/month per key (two keys, so $2/month) plus $0.15 per 10,000 `Sign` requests.
  Asymmetric requests have no free tier. A million earns costs $15.
- **Throughput**: `Sign` on ECC keys shares a default quota of 1,000 requests/second per account
  and region, far above what one issuer address can push through Sui's per-sender object locking.
  The signer retries throttling (429) with exponential backoff.

Accepted trade-off: the extra round trip is not cached or batched away. A signature can't be
reused, and holding key material locally to save that time is exactly what this change removes.
From Vietnam, Sydney costs about half a second per signature; a worker hosted in or near
`ap-southeast-2` pays a small fraction of that.

| Date | From | Key region | `GetPublicKey` (cold) | `Sign` p50 / p95 (20 samples) |
| --- | --- | --- | --- | --- |
| 2026-10-30 | Laptop, Vietnam (`aws login` profile) | `ap-southeast-2` | 2,693 ms issuer (first credential resolution), 383 ms admin | issuer 521 / 727 ms; admin 519 / 851 ms |

## Still deferred (not part of OCT-245)

- Mainnet keys and their stricter key policy: KMS-generated material, named key administrators
  separate from key users, `kms:ScheduleKeyDeletion` denied to everyone but a break-glass role, a
  CloudWatch alarm on `Sign` by any unexpected principal, and the worker on AWS compute with no
  access keys at all.
- **Key loss is cap loss.** An asymmetric KMS key can't be rotated in place. Rotating means a new
  key, then transferring every cap to the new address. Deleting a key waits 7–30 days (use 30).
  Treat a pending deletion as an incident.
- Per-tenant key separation, `IssuerCap`/`AdminCap` revocation, and spend-anomaly detection: see
  `docs/roadmap.md`.
