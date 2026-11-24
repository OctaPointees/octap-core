terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Created by infra/bootstrap. The bucket name carries the AWS account id, which is not a secret.
  # use_lockfile: S3's own locking (Terraform 1.10+), so two applies cannot run at once.
  backend "s3" {
    bucket       = "octap-tfstate-967307910342"
    key          = "staging/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project    = "octap"
      env        = "staging"
      managed_by = "terraform"
    }
  }
}
