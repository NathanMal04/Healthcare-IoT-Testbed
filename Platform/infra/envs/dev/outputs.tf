# Outputs usefull values

output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnet_public_id" {
  value = aws_subnet.public.id
}

output "subnet_private_app_id" {
  value = aws_subnet.private_app.id
}

output "subnet_private_db_id" {
  value = aws_subnet.private_db.id
}
