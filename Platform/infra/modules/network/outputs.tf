output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_arn" {
  value = aws_vpc.this.arn
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "private_subnet_arns" {
  value = aws_subnet.private[*].arn
}

output "job_security_group_id" {
  value = aws_security_group.job.id
}

# For the interface endpoints the network-controller Lambda creates.
output "endpoint_security_group_id" {
  value = aws_security_group.endpoints.id
}

output "endpoint_security_group_arn" {
  value = aws_security_group.endpoints.arn
}

# Policy for every interface endpoint except execute-api: principals of this
# account only.
output "account_only_endpoint_policy" {
  value = local.account_only_policy
}

output "alb_subnet_ids" {
  value = aws_subnet.alb[*].id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "session_security_group_id" {
  value = aws_security_group.session.id
}

output "internet_gateway_id" {
  value = aws_internet_gateway.this.id
}
