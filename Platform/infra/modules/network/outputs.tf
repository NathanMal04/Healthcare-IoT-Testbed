output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "job_security_group_id" {
  value = aws_security_group.job.id
}

output "execute_api_endpoint_id" {
  value = aws_vpc_endpoint.interface["execute-api"].id
}
