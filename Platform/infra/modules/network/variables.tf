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
  description = "Availability zones to spread subnets and interface endpoints over. Each interface endpoint costs about $7.30 a month per zone."
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

variable "enable_ecs_endpoints" {
  description = "Create the ecs, ecs-agent and ecs-telemetry endpoints that EC2 (Heavy) instances need without a NAT."
  type        = bool
  default     = false
}

variable "project" {
  description = "Project tag value."
  type        = string
}

variable "environment" {
  description = "Environment tag value (dev/staging/prod)."
  type        = string
}
