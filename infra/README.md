# Infrastructure

Terraform for Core's AWS staging environment (OCT-316), region `ap-southeast-2`.

- `bootstrap/`: the S3 bucket that holds Terraform's state. Run once per AWS account.
- `staging/`: everything else. So far (OCT-318): the network, the image registry, the log groups
  and a monthly budget alert.

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

## Rules

- `apply` is always run by hand, after reading the plan. Nothing applies automatically.
- No secrets in these files, in `terraform.tfvars` or in outputs. Secret values go into Secrets
  Manager by hand (OCT-319).
- Commit `.terraform.lock.hcl`; never commit state, plans or `terraform.tfvars`.
