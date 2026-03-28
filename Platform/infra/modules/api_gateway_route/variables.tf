variable "rest_api_id" {
  description = "ID of the REST API."
  type        = string
}

variable "parent_resource_id" {
  description = "Parent resource ID (use root_resource_id for top-level routes)."
  type        = string
}

variable "execution_arn" {
  description = "Execution ARN of the REST API (for Lambda permissions)."
  type        = string
}

variable "path_part" {
  description = "URL path segment for this route (e.g. users, devices)."
  type        = string
}

variable "http_method" {
  description = "HTTP method (GET, POST, PUT, DELETE, etc.)."
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Invoke ARN of the Lambda function handling this route."
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Lambda function (for the invoke permission)."
  type        = string
}

variable "authorization" {
  description = "Authorization type: NONE or COGNITO_USER_POOLS."
  type        = string
  default     = "NONE"
}

variable "authorizer_id" {
  description = "Cognito authorizer ID (required when authorization is COGNITO_USER_POOLS)."
  type        = string
  default     = null
}
