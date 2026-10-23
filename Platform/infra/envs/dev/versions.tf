# Sets requirement for minimum Terraform version
terraform {
  required_version = ">= 1.6.0"

  # State stored in S3 — bucket must be created before first init
  backend "s3" {
    bucket = "healthcare-iot-testbed-tf-state"
    key    = "dev/terraform.tfstate"
    region = "us-east-2"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.25.0"
    }
  }
}
