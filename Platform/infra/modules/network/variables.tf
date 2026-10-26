variable "name" {
  description = "Name prefix for the network resources."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Availability zones for the private subnets that jobs, sessions and interface endpoints use. Each interface endpoint costs about $0.01 an hour per zone while it exists."
  type        = number
  default     = 1
}

variable "region" {
  description = "AWS region (for the VPC endpoint service names)."
  type        = string
}

variable "account_id" {
  description = "This account's id. Endpoint policies only allow principals from it."
  type        = string
}

variable "data_lake_bucket_arn" {
  description = "ARN of the data lake bucket jobs read inputs from and write outputs to."
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

variable "session_port" {
  description = "Port JupyterLab listens on in notebook session tasks."
  type        = number
  default     = 8888
}
