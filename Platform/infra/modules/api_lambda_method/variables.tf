variable "rest_api_id" {
  description = "ID of the REST API."
  type        = string
}

variable "resource_id" {
  description = "ID of the API Gateway resource the method is added to."
  type        = string
}

variable "execution_arn" {
  description = "Execution ARN of the REST API (for the Lambda permission)."
  type        = string
}

variable "http_method" {
  description = "HTTP method (GET, POST, PUT, DELETE, etc.)."
  type        = string
}

variable "route_path" {
  description = "Route path without a leading slash, with path parameters as * (e.g. artifacts/*/parts)."
  type        = string
}

variable "authorizer_id" {
  description = "Cognito authorizer ID."
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Invoke ARN of the Lambda function handling this method."
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Lambda function handling this method."
  type        = string
}

variable "statement_suffix" {
  description = "Unique suffix for the Lambda permission statement ID (e.g. artifacts-parts-POST)."
  type        = string
}
