# Worker signers on AWS KMS

The worker signs Sui transactions with two keys: the **issuer** key (holds every program's
`IssuerCap`; signs `open_account`, `earn`, reversals) and the **program admin** key (holds each
program's `AdminCap`; signs provisioning and budget top-ups). This page covers how those keys
live in AWS KMS: what was decided, how to provision them once, how a developer or a deployed
worker gets access, and what each signature costs.

Code: [`api/src/infra/clients/sui/signer.ts`](../api/src/infra/clients/sui/signer.ts). Smoke
test and latency check: [`scripts/check-kms-signer.mjs`](../scripts/check-kms-signer.mjs).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Provider | AWS KMS | Team choice (OCT-245). The private key never leaves KMS; the worker holds only a key reference and calls `kms:Sign`. |
| Signer code | Mysten's `@mysten/aws-kms-signer`, not a hand-rolled `@aws-sdk/client-kms` adapter | Mysten maintains it next to `@mysten/sui`. It reads the scheme from the key's `KeySpec`, and it handles DER decoding and secp256k1 low-S normalization (the pieces Harbor wrote by hand for GCP). It accepts any AWS credential provider, so we pass the AWS SDK's own `defaultProvider()` chain. Retries KMS 5xx/429 with backoff. |
| Key spec | `ECC_NIST_EDWARDS25519` (Ed25519, `ED25519_SHA_512`) | Same scheme as today's raw keys. KMS has supported it since Nov 2025. Ed25519 has none of ECDSA's signature malleability, so there is no low-S step. `ECC_SECG_P256K1` (what Harbor uses on GCP) also works unchanged, because the scheme comes from the key. Pick it only if you have a reason to. |
| One key or two | **Two keys**, `alias/octap-testnet-issuer` and `alias/octap-testnet-program-admin` | The split exists because the blast radii differ: an `AdminCap` can mint `IssuerCap`s and rotate policy. Two keys only help if different principals can use them, so each key gets its own IAM role (below). The long-running worker never holds `kms:Sign` on the admin key. |
| Credentials | AWS SDK default chain (`@aws-sdk/credential-provider-node`) | The same code works everywhere. On a laptop it uses a named profile (assume-role, SSO or `aws login`). On a non-AWS host it uses env keys. On AWS compute (ECS task role, EKS Pod Identity/IRSA, EC2 instance profile) there is no downloadable credential at all. |
| Raw keys | Local fallback only, refused on mainnet | When `SUI_*_KMS_KEY_ID` is unset, `SUI_*_PRIVATE_KEY` still works, with a warning, so a contributor without AWS access can still run the worker locally. On `SUI_NETWORK=mainnet` the worker refuses a raw key: mainnet signs through KMS or not at all (Harbor's "production requires KMS" guard). The shared testnet/staging worker should always run on KMS. |
| Region | `ap-southeast-1` (Singapore) | The closest KMS region to the team (Vietnam). Any region works, because a key ARN carries its own. |

## Environment

| Variable | Example | Notes |
| --- | --- | --- |
| `SUI_ISSUER_KMS_KEY_ID` | `alias/octap-testnet-issuer` | Key id, key ARN, alias name, or alias ARN. |
| `SUI_PROGRAM_ADMIN_KMS_KEY_ID` | `alias/octap-testnet-program-admin` | Same forms. |
| `AWS_REGION` | `ap-southeast-1` | Needed unless the key id is an ARN. |
| `AWS_PROFILE` | `octap-testnet-worker` | Or any other source the default chain reads. **Never** put access keys for a human in `.env`. |

The public key is fetched once per process, on first use (`GetPublicKey`). Each transaction then
costs exactly one `Sign` call. A failed load (throttling, expired credentials) is not cached, so
the next attempt retries it.

## One-time provisioning (AWS account admin)

These steps need an identity that can create KMS keys and IAM roles. Replace `<ACCOUNT_ID>`
throughout. Everything is tagged `project=octap, env=testnet` so it's easy to find and audit.

### 1. Create the two keys

```bash
export AWS_REGION=ap-southeast-1
for role in issuer program-admin; do
  KEY_ID=$(aws kms create-key \
    --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY \
    --description "OctaP testnet Sui ${role} signer" \
    --tags TagKey=project,TagValue=octap TagKey=env,TagValue=testnet TagKey=signer,TagValue=$role \
    --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name alias/octap-testnet-$role --target-key-id "$KEY_ID"
  echo "$role: arn:aws:kms:$AWS_REGION:<ACCOUNT_ID>:key/$KEY_ID"
done
```

Keep the default key policy, which delegates to IAM. Permissions are granted by the role policies
below. Note the two key ARNs; the policies need ARNs, not aliases.

### 2. One role per key

Trust policy for both roles (`trust.json`). Any principal in the account that is *also* allowed
`sts:AssumeRole` on the role by its own IAM policy can assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:root" }, "Action": "sts:AssumeRole" }]
}
```

`issuer-signer.json`: signs with the issuer key only.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:Sign", "kms:GetPublicKey"],
    "Resource": "<ISSUER_KEY_ARN>"
  }]
}
```

`program-admin-signer.json`: signs with the admin key. It can also *read* the issuer public key,
because provisioning mints each new `IssuerCap` to the issuer's address. It can't sign with it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["kms:Sign", "kms:GetPublicKey"], "Resource": "<PROGRAM_ADMIN_KEY_ARN>" },
    { "Effect": "Allow", "Action": "kms:GetPublicKey", "Resource": "<ISSUER_KEY_ARN>" }
  ]
}
```

```bash
aws iam create-role --role-name OctapTestnetIssuerSigner --assume-role-policy-document file://trust.json \
  --max-session-duration 43200 --tags Key=project,Value=octap Key=env,Value=testnet
aws iam put-role-policy --role-name OctapTestnetIssuerSigner --policy-name kms-sign \
  --policy-document file://issuer-signer.json
aws iam create-role --role-name OctapTestnetProgramAdmin --assume-role-policy-document file://trust.json \
  --tags Key=project,Value=octap Key=env,Value=testnet
aws iam put-role-policy --role-name OctapTestnetProgramAdmin --policy-name kms-sign \
  --policy-document file://program-admin-signer.json
```

### 3. A developer group whose only power is assuming those roles

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "sts:AssumeRole",
    "Resource": [
      "arn:aws:iam::<ACCOUNT_ID>:role/OctapTestnetIssuerSigner",
      "arn:aws:iam::<ACCOUNT_ID>:role/OctapTestnetProgramAdmin"
    ]
  }]
}
```

```bash
aws iam create-group --group-name octap-testnet-devs
aws iam put-group-policy --group-name octap-testnet-devs --policy-name assume-signer-roles \
  --policy-document file://assume-signer-roles.json
# per developer:
aws iam create-user --user-name <name> --tags Key=project,Value=octap
aws iam add-user-to-group --user-name <name> --group-name octap-testnet-devs
aws iam create-access-key --user-name <name>   # hand the result to that developer, once
```

That access key is the developer's **single scoped credential**. On its own it can't sign
anything or touch any other AWS resource. It can only obtain short-lived role sessions, and
CloudTrail records which developer each `Sign` came from. If the team uses IAM Identity Center
(SSO), use a permission set with the same `sts:AssumeRole` statement instead of IAM users.

### 4. Fund the two addresses

```bash
AWS_PROFILE=octap-testnet-admin node --env-file=.env scripts/check-kms-signer.mjs both 3
```

This prints each signer's Sui address. Fund both from the testnet faucet: they pay their own gas.
Record the issuer address in `contracts/sui/DEPLOYMENTS.md`.

## Developer setup (each teammate, once)

```bash
aws configure --profile octap-dev   # paste the access key from step 3; region ap-southeast-1
```

Add to `~/.aws/config`:

```ini
[profile octap-testnet-worker]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/OctapTestnetIssuerSigner
source_profile = octap-dev
region = ap-southeast-1

[profile octap-testnet-admin]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/OctapTestnetProgramAdmin
source_profile = octap-dev
region = ap-southeast-1
```

In `.env` (no secrets in here, only references):

```dotenv
AWS_REGION=ap-southeast-1
AWS_PROFILE=octap-testnet-worker
SUI_ISSUER_KMS_KEY_ID=alias/octap-testnet-issuer
SUI_PROGRAM_ADMIN_KMS_KEY_ID=alias/octap-testnet-program-admin
SUI_ISSUER_PRIVATE_KEY=
SUI_PROGRAM_ADMIN_PRIVATE_KEY=
```

The worker then runs as the issuer role. Admin-key scripts override the profile from the shell,
and Node's `--env-file` never overrides a variable that is already set:

```bash
node --env-file=.env api/dist/worker.js
AWS_PROFILE=octap-testnet-admin node --env-file=.env scripts/provision-program.mjs <orgId> 500 365 1000000
AWS_PROFILE=octap-testnet-admin node --env-file=.env scripts/top-up-budget.mjs <orgId> 100000
node --env-file=.env scripts/check-kms-signer.mjs issuer 20   # smoke + latency
```

## The deployed testnet/staging worker

The testnet deployment is also the staging environment real users touch, so it gets the
production shape wherever the host allows:

- **On AWS compute** (ECS/Fargate, EKS, EC2): attach `OctapTestnetIssuerSigner`'s policy to the
  task role, pod identity or instance profile. Don't set any AWS key variables; the default chain
  picks up the role. This is the target shape for mainnet too.
- **On a non-AWS host**: create a dedicated IAM user `octap-testnet-worker`. Attach
  `issuer-signer.json` to it directly (only the issuer key, never the admin key), and store its
  access key in the host's secret store as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Rotate
  that key on a schedule. Provisioning and top-ups still run from a developer machine under the
  admin role, never from the hosted worker.

## Moving off the old raw keys

The KMS addresses are new addresses, so anything the old raw-key addresses own stays with them:

- **Existing programs' `AdminCap`s and `IssuerCap`s** belong to the old addresses. Both caps have
  `store`, so the old key can hand them over: `sui client transfer --object-id <cap>
  --to <new address>`. Transferring keeps every existing program and `CreditAccount` working.
  Re-provisioning the organizations also works: the worker reopens members' accounts in the new
  program on their next earn (OCT-244). But credits already in the old accounts stay in the old
  program; see `docs/roadmap.md`.
- After that, delete the raw keys from every `.env` and drain the old addresses' SUI.

## Latency and cost

- **Per transaction**: one `Sign` round trip to KMS, added to the build → sign → execute → wait
  path. Checkpoint finality is the dominant term. Measure the KMS share on your own machine with
  `scripts/check-kms-signer.mjs`, and record the numbers in the table below whenever the key
  location or the deployment changes.
- **Per process**: one `GetPublicKey` plus a credential resolution on first use (assume-role adds
  an STS call), then cached.
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

| Date | From | Key region | `GetPublicKey` (cold) | `Sign` p50 / p95 |
| --- | --- | --- | --- | --- |
| _pending first provisioning_ | | `ap-southeast-1` | | |

## Still deferred (not part of OCT-245)

- Mainnet keys and their stricter key policy: named key administrators separate from key users,
  `kms:ScheduleKeyDeletion` denied to everyone but a break-glass role, a CloudWatch alarm on
  `Sign` by any unexpected principal, and the worker on AWS compute with no access keys at all.
- **Key loss is cap loss.** KMS keys can't be exported and an asymmetric key can't be rotated in
  place. Rotating means a new key, then transferring every cap to the new address. Deleting a key
  waits 7–30 days (use 30). Treat a pending deletion as an incident.
- Per-tenant key separation, `IssuerCap`/`AdminCap` revocation, and spend-anomaly detection: see
  `docs/roadmap.md`.
