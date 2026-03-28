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