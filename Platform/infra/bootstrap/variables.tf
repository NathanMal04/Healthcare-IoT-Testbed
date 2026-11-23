variable "aws_region" {
  description = "Region the platform is deployed to. Must match aws_region in envs/dev."
  type        = string
  default     = "us-east-2"
}

variable "aws_profile" {
  description = "AWS CLI profile to run the bootstrap with (null uses the default credential chain)."
  type        = string
  default     = null
}

variable "name" {
  description = "Resource name prefix. Must match name in envs/dev: the deploy policies are scoped to it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,28}$", var.name))
    error_message = "name must be 3-29 lowercase letters, digits and hyphens (the same as in envs/dev)."
  }
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket for Terraform state. Globally unique."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository allowed to assume the deploy role, as owner/repo. Null skips the GitHub OIDC provider and deploy role (local deploys only)."
  type        = string
  default     = null
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC identity provider. An account can only have one; set false if it already exists, and the existing one is used."
  type        = bool
  default     = true
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone the deploy role may write DNS records to, when envs/dev uses one (route53_zone_id there). Empty grants no Route 53 access."
  type        = string
  default     = ""
}
