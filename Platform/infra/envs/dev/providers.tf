# Default provider (your current one)
provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile != "" ? var.aws_profile : null
}

# New provider for ACM (CloudFront requirement)
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile != "" ? var.aws_profile : null
}