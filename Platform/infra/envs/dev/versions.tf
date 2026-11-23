# Sets requirement for minimum Terraform version
terraform {
  required_version = ">= 1.6.0"

  # State stored in S3. The bucket, key and region come from backend.hcl
  # (git-ignored; see backend.hcl.example), or -backend-config flags in CI:
  #   terraform init -backend-config=backend.hcl
  # The bucket must exist first (Platform/infra/bootstrap creates one).
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.25.0"
    }
  }
}
