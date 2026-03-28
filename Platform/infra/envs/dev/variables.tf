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
  default = ["https://localhost:3000"]
}

variable "cognito_logout_urls" {
  type    = list(string)
  default = ["https://localhost:3000"]
}

variable "dynamodb_hash_key" {
  type    = string
  default = "pk"
}

variable "dynamodb_range_key" {
  type    = string
  default = "sk"
}

variable "dynamodb_attributes" {
  type = list(object({
    name = string
    type = string
  }))
  default = [
    { name = "pk", type = "S" },
    { name = "sk", type = "S" },
  ]
}
