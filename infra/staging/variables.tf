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
