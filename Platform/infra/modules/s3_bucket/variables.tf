variable "bucket_name" {
  description = "Globally unique S3 bucket name."
  type        = string
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}

variable "cors_rules" {
  description = "Optional CORS rules. Leave empty to skip CORS configuration."
  type = list(object({
    allowed_headers = list(string)
    allowed_methods = list(string)
    allowed_origins = list(string)
    expose_headers  = list(string)
    max_age_seconds = number
  }))
  default = []
}
variable "lifecycle_rules" {
  description = "Optional lifecycle rules. Each rule filters on a key prefix and, optionally, object tags."
  type = list(object({
    id                                     = string
    prefix                                 = optional(string, "")
    tags                                   = optional(map(string), {})
    abort_incomplete_multipart_upload_days = optional(number)
    expiration_days                        = optional(number)
  }))
  default = []
}
