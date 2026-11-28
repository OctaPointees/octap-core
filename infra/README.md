# Infrastructure

Terraform for Core's AWS staging environment (OCT-316), region `ap-southeast-2`.

- `bootstrap/`: the S3 bucket that holds Terraform's state. Run once per AWS account.
- `staging/`: everything else. So far: the network, the image registry, the log groups and a
  monthly budget alert (OCT-318); Postgres, Redis, the secrets, the ECS cluster and the migration
  task (OCT-319); the load balancer, `api.octap.biz` and the `api` service (OCT-320).

## First time

```sh
aws login --profile octap-admin          # an identity that can create these resources
export AWS_PROFILE=octap-admin

cd infra/bootstrap && terraform init && terraform apply
cd ../staging
cp terraform.tfvars.example terraform.tfvars   # set budget_alert_emails
terraform init && terraform plan
terraform apply                                 # after reading the plan
```

**Signed in with `aws login`?** The S3 backend does not read those credentials (`No valid credential
sources found` at `terraform init`). Export short-lived ones for the shell first:

```sh
eval "$(aws configure export-credentials --profile octap-admin --format env)"   # bash
aws configure export-credentials --profile octap-admin --format powershell | Invoke-Expression   # PowerShell
```

`bootstrap/` keeps its own state locally (git-ignored). Losing it is harmless: the bucket has
`prevent_destroy`, and `terraform import aws_s3_bucket.state octap-tfstate-<account id>` rebuilds it.

## Database, Redis and secrets (OCT-319)

Postgres (RDS) and Redis (ElastiCache) have no public address; only tasks in the `tasks` security
group reach them. Terraform creates the secrets in `terraform output secret_names`. Values other
than `DATABASE_URL` are set by hand, never in a file in this repo:

1. **An image in ECR.** Until the deploy pipeline exists (OCT-322), push one by hand, tagged with
   its commit SHA, and put that SHA in `terraform.tfvars` as `image_tag`:

   ```sh
   REPO=$(terraform output -raw ecr_repository_url); TAG=$(git rev-parse --short HEAD)
   aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
   docker build -t "$REPO:$TAG" ../.. && docker push "$REPO:$TAG"
   ```

2. **`DATABASE_URL`: nothing to do.** Terraform generates the database password and writes the
   whole URL (with `sslmode=require`: RDS refuses connections without TLS) into the secret. Both
   are write-only, so the password is never in state. For a new password, bump
   `db_password_version` and apply. If an apply fails halfway, bump `db_password_version` again:
   rerunning with the same number won't resend the password, and the secret could keep the old one.

3. **The other secrets** (`ENOKI_API_KEY`, `MCP_OAUTH_SIGNING_KEY`, `OPENAI_API_KEY`,
   `ORGANIZATION_IDENTITY_ENCRYPTION_KEY`; what each one is: `.env.example`):

   ```sh
   aws secretsmanager put-secret-value --secret-id octap-staging/<NAME> --secret-string '<value>'
   ```

   `REDIS_URL` is not a secret (TLS, no password): `terraform output redis_url`, used as a plain
   task setting.

4. **Migrate.** Runs `scripts/migrate.mjs` once, in a public subnet so it can pull the image:

   ```sh
   aws ecs run-task --cluster octap-staging --launch-type FARGATE \
     --task-definition octap-staging-migrate \
     --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json public_subnet_ids | jq -r '.[0]')],securityGroups=[$(terraform output -raw tasks_security_group_id)],assignPublicIp=ENABLED}"
   ```

   Its log is in CloudWatch, `/octap/staging/migrate`.

The migrations were written for Supabase. `scripts/migrate.mjs` creates Supabase's roles first on
a plain Postgres. RDS's admin user is not a superuser, but it may still create `service_role`
with `BYPASSRLS` (staging's has it). On a Postgres where the user may not, it is created without
`BYPASSRLS`. Nothing in Core runs as `service_role`.

## The API at api.octap.biz (OCT-320)

An application load balancer serves `https://api.octap.biz` (HTTP redirects to HTTPS) and forwards
to the `api` ECS service, health-checked on `/health`. The tasks accept traffic from the load
balancer only. The certificate (ACM) and the DNS records live in Cloudflare, created by
Terraform, DNS only: Cloudflare's proxy would cut a stream at 100 seconds.

1. **A Cloudflare API token** on the `octap.biz` zone with Zone Read (Terraform looks the zone up by
   name) and DNS Edit, in the shell, never in a file here:

   ```sh
   export CLOUDFLARE_API_TOKEN=...                 # bash
   $env:CLOUDFLARE_API_TOKEN = '...'               # PowerShell
   ```

2. **`terraform.tfvars`**: `console_google_client_id`, the Google OAuth client the console signs in
   with (the same one the web apps use).

3. **Feature secrets.** The API starts with only `DATABASE_URL`; each feature secret left out turns
   its feature off (503). A task can't start while a secret it names has no value, so set the
   value first (step 3 above), then add its name to `api_feature_secrets` and apply:

   ```hcl
   api_feature_secrets = ["ENOKI_API_KEY", "ORGANIZATION_IDENTITY_ENCRYPTION_KEY"]
   ```

4. **Google sign-in.** Add `https://api.octap.biz` to the OAuth client's Authorized JavaScript
   origins (Google Cloud console). Terraform doesn't manage the client.

Check it: `curl https://api.octap.biz/health` returns 200. A new `image_tag` rolls the service out;
one that never turns healthy is rolled back by ECS.

## Rules

- `apply` is always run by hand, after reading the plan. Nothing applies automatically.
- No secrets in these files, in `terraform.tfvars` or in outputs. Secret values go into Secrets
  Manager by hand (OCT-319); Terraform only writes generated ones, write-only.
- Commit `.terraform.lock.hcl`; never commit state, plans or `terraform.tfvars`.
