terraform {
  required_version = ">= 1.6.0"

  # Local state only — no S3 backend needed
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.25.0"
    }
  }
}
