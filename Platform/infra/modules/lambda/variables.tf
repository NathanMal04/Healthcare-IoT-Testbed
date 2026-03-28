variable "function_name" {
  description = "Name of the Lambda function."
  type        = string
}

variable "package_type" {
  description = "Deployment package type: Zip or Image."
  type        = string
  default     = "Zip"
}

# --- Zip deployment ---

variable "source_dir" {
  description = "Path to the directory containing the function source code (Zip only)."
  type        = string
  default     = null
}

variable "handler" {
  description = "Function entrypoint e.g. index.handler (Zip only)."
  type        = string
  default     = "index.handler"
}

variable "runtime" {
  description = "Lambda runtime e.g. nodejs20.x, python3.12 (Zip only)."
  type        = string
  default     = "nodejs20.x"
}

# --- Container deployment ---

variable "image_uri" {
  description = "ECR image URI for the Lambda function (Image only)."
  type        = string
  default     = null
}

# --- Durable execution (https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) ---

variable "durable" {
  description = "Enable durable execution with checkpoint support."
  type        = bool
  default     = false
}

variable "durable_execution_timeout" {
  description = "Max durable execution time in seconds."
  type        = number
  default     = 900
}

variable "durable_retention_period" {
  description = "Days to retain durable execution state."
  type        = number
  default     = 7
}

variable "durable_alias_name" {
  description = "Alias name for the durable function (use alias ARN for invocations)."
  type        = string
  default     = "prod"
}

# --- Compute ---

variable "memory_size" {
  description = "Amount of memory in MB."
  type        = number
  default     = 128
}

variable "timeout" {
  description = "Max execution time in seconds (max 900)."
  type        = number
  default     = 30
}

# --- Permissions ---

variable "additional_policy_arns" {
  description = "Extra IAM policy ARNs to attach to the function role."
  type        = list(string)
  default     = []
}

# --- Config ---

variable "environment_variables" {
  description = "Environment variables passed to the function."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 14
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}
