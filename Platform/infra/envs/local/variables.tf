variable "name" {
  type    = string
  default = "healthcare-iot-testbed-local"
}

variable "localstack_endpoint" {
  type    = string
  default = "http://localstack:4566"
}

variable "cognito_callback_urls" {
  type    = list(string)
  default = ["http://localhost:3000"]
}

variable "cognito_logout_urls" {
  type    = list(string)
  default = ["http://localhost:3000"]
}

