variable "s3_bucket_name" {
  description = "Name of the S3 origin bucket."
  type        = string
}

variable "s3_bucket_regional_domain_name" {
  description = "Regional domain name of the S3 origin bucket."
  type        = string
}

variable "s3_bucket_arn" {
  description = "ARN of the S3 origin bucket."
  type        = string
}

variable "default_root_object" {
  description = "Object CloudFront returns for the root URL."
  type        = string
  default     = "index.html"
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}
