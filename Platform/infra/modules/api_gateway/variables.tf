variable "api_name" {
  description = "Name of the REST API."
  type        = string
}

variable "stage_name" {
  description = "Deployment stage name (e.g. dev, prod)."
  type        = string
  default     = "dev"
}

variable "cognito_user_pool_arn" {
  description = "Cognito user pool ARN for the authorizer. Set to null to skip."
  type        = string
  default     = null
}

variable "deployment_trigger" {
  description = "Change this value to trigger a redeployment (use a hash of route resource IDs)."
  type        = string
  default     = "initial"
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}
