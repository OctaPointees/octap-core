# Core's secrets (OCT-319). Terraform creates each secret; DATABASE_URL's value comes from
# data.tf (write-only), every other value is set by hand (infra/README.md). No value is ever in
# these files, terraform.tfvars or state. Settings that are not secret (REDIS_URL, KMS key ids,
# the Google client id) are plain task settings instead.
locals {
  secret_names = toset([
    "DATABASE_URL",
    "ENOKI_API_KEY",
    "MCP_OAUTH_SIGNING_KEY",
    "OPENAI_API_KEY",
    "ORGANIZATION_IDENTITY_ENCRYPTION_KEY",
  ])
}

resource "aws_secretsmanager_secret" "core" {
  for_each = local.secret_names
  name     = "${var.name}/${each.key}"
  # Staging: deleting a secret takes effect at once instead of after a 30-day wait.
  recovery_window_in_days = 0
}
