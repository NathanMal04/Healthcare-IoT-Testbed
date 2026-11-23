variable "rest_api_id" {
  description = "ID of the REST API."
  type        = string
}

variable "resource_id" {
  description = "ID of the API Gateway resource the preflight is added to."
  type        = string
}

variable "allowed_methods" {
  description = "Methods the resource accepts, not counting OPTIONS (e.g. [\"GET\", \"POST\"])."
  type        = list(string)
}

variable "allowed_origin" {
  description = "Value for Access-Control-Allow-Origin (the site's origin, e.g. https://example.com)."
  type        = string
}
