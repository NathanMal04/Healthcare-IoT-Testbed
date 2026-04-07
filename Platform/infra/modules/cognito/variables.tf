variable "pool_name" {
  description = "Name of the Cognito user pool."
  type        = string
}

variable "password_min_length" {
  description = "Minimum password length."
  type        = number
  default     = 8
}

variable "callback_urls" {
  description = "Allowed callback URLs for the app client."
  type        = list(string)
  default     = []
}

variable "logout_urls" {
  description = "Allowed logout URLs for the app client."
  type        = list(string)
  default     = []
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}

variable "post_confirmation_lambda_arn" {
  description = "ARN of Lambda to invoke after user confirmation."
  type        = string
  default     = null
}
