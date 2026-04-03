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
