# One-time setup for a new AWS account: the Terraform state bucket and the
# role GitHub Actions deploys with. Run it once, from your own (admin)
# credentials, before the first `envs/dev` deploy. See SELF_HOSTING.md.
#
# State is kept locally (bootstrap/terraform.tfstate, git-ignored): the state
# bucket can't hold the state of the configuration that creates it. Keep that
# file, or move it into the new bucket afterwards (SELF_HOSTING.md).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.25.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}
