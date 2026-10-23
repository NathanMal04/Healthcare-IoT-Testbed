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
  type    = string
  default = "healthcare-iot-testbed-dev"
}

variable "cognito_callback_urls" {
  type    = list(string)
  default = ["https://localhost:3000", "d83vem2v9vlw.cloudfront.net"]
}

variable "cognito_logout_urls" {
  type    = list(string)
  default = ["https://localhost:3000", "d83vem2v9vlw.cloudfront.net"]
}

variable "domain_name" {
  description = "Primary custom domain for the frontend"
  type        = string
}

variable "domain_aliases" {
  description = "Additional custom domains for the frontend certificate"
  type        = list(string)
  default     = []
}
variable "enable_heavy_class" {
  description = "Create the Heavy (EC2) run class. Adds the ecs, ecs-agent and ecs-telemetry VPC endpoints (about $22/month in one zone)."
  type        = bool
  default     = true
}

variable "default_monthly_limit" {
  description = "Monthly spending limit (USD) for users who don't have a budget yet."
  type        = string
  default     = "25"
}
