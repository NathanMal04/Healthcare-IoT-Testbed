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

