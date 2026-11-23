# Stores variables being used in central location

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "aws_profile" {
  type        = string
  description = "AWS CLI profile name (set to empty string in CI)."
  default     = null
}

variable "name" {
  description = "Prefix for every resource name. S3 bucket names derive from it, so it must be globally unique."
  type        = string

  # At most 29 characters: "<name>-nb" (the sessions load balancer) is
  # limited to 32 and "<name>-post-confirmation-create-user-role" to 64. Also
  # catches CI passing an unset repository variable as "", which would rename
  # (replace) every resource.
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,28}$", var.name))
    error_message = "name must be 3-29 lowercase letters, digits and hyphens. In CI, set the TF_NAME repository variable."
  }
}

# Hosted UI only, which isn't configured (README "Authentication"), so inert.
variable "cognito_callback_urls" {
  type    = list(string)
  default = ["https://localhost:3000"]
}

variable "cognito_logout_urls" {
  type    = list(string)
  default = ["https://localhost:3000"]
}

variable "domain_name" {
  description = "Domain the site is served at (e.g. testbed.example.com). The app's one origin: every other hostname redirects to it."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a lowercase hostname such as testbed.example.com (no scheme or path). In CI, set the DOMAIN_NAME repository variable."
  }
}

variable "include_www" {
  description = "Also serve (and redirect) www.<domain_name>, and put it on the certificate."
  type        = bool
  default     = true
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone of domain_name. When set, Terraform validates the certificate and creates the site's DNS records (dns.tf); empty means DNS is managed by hand."
  type        = string
  default     = ""
}

variable "extra_allowed_origins" {
  description = "Origins besides https://<domain_name> allowed to upload straight to the data lake bucket (S3 CORS)."
  type        = list(string)
  default     = ["http://localhost:3000"]
}

variable "brand_name" {
  description = "Product name shown in the web app and the sign-up email. Empty means the default, Vzoniq (CI passes an unset repository variable as empty)."
  type        = string
  default     = ""
}
variable "enable_heavy_class" {
  description = "Create the Heavy (EC2) run class. Its ecs, ecs-agent and ecs-telemetry VPC endpoints are created on demand, only while Heavy runs need them (network.tf)."
  type        = bool
  default     = true
}

variable "default_monthly_limit" {
  description = "Monthly spending limit (USD) for users who don't have a budget yet."
  type        = string
  default     = "25"
}

variable "network_idle_minutes" {
  description = "How long the on-demand VPC endpoints stay up after the last run or notebook session finishes (network.tf). Each hour up costs about $0.04 ($0.07 with Heavy)."
  type        = number
  default     = 120
}
