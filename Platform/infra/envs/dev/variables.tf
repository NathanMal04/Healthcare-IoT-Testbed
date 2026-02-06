# Stores variables being used in centra location

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "aws_profile" {
  type        = string
  description = "AWS CLI profile name"
}

variable "name" {
  type    = string
  default = "healthcare-iot-testbed-dev"
}

variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "public_subnet_cidr" {
  type    = string
  default = "10.10.1.0/24"
}

variable "private_app_subnet_cidr" {
  type    = string
  default = "10.10.2.0/24"
}

variable "private_db_subnet_cidr" {
  type    = string
  default = "10.10.3.0/24"
}
