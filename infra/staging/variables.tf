variable "region" {
  description = "Where everything runs: the same region as the KMS signing keys (docs/kms-signer.md)."
  type        = string
  default     = "ap-southeast-2"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "octap-staging"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "monthly_budget_usd" {
  description = "The budget alert fires at 80% of this (actual) and 100% (forecast)."
  type        = number
  default     = 120
}

variable "budget_alert_emails" {
  description = "Who gets the budget alerts. Set in terraform.tfvars (not committed)."
  type        = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "image_tag" {
  description = "The octap-core image the tasks run: a commit SHA pushed to the ECR repository."
  type        = string
}

variable "db_password_version" {
  description = "Bump to give the database a new random password (and DATABASE_URL with it)."
  type        = number
  default     = 1
}

variable "domain" {
  description = "The Cloudflare zone the public addresses live in (api.<domain>)."
  type        = string
  default     = "octap.biz"
}

variable "console_google_client_id" {
  description = "The Google OAuth client id console sign-in verifies against (public, not a secret). Set in terraform.tfvars."
  type        = string
}

variable "api_feature_secrets" {
  description = <<-EOT
    The API's optional feature secrets (secrets.tf) to pass to it. A task can't start while a
    secret it names has no value, so add a name only after its value is set (infra/README.md).
    Each one left out only turns its feature off (503).
  EOT
  type        = list(string)
  default     = []
  validation {
    condition = alltrue([
      for s in var.api_feature_secrets :
      contains(["ENOKI_API_KEY", "MCP_OAUTH_SIGNING_KEY", "OPENAI_API_KEY", "ORGANIZATION_IDENTITY_ENCRYPTION_KEY"], s)
    ])
    error_message = "Each entry must be one of the API's feature secrets: ENOKI_API_KEY, MCP_OAUTH_SIGNING_KEY, OPENAI_API_KEY, ORGANIZATION_IDENTITY_ENCRYPTION_KEY."
  }
}
