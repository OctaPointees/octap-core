terraform {
  # 1.11: write-only attributes, so the database password never reaches state (data.tf).
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    # DNS for api.octap.biz and its certificate (OCT-320). Reads CLOUDFLARE_API_TOKEN.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
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

# The token comes from CLOUDFLARE_API_TOKEN (DNS edit on the zone), never from a file here.
provider "cloudflare" {}
