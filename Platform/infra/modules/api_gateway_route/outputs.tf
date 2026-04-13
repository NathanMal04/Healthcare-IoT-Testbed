output "resource_id" {
  value = aws_api_gateway_resource.this.id
}

output "http_method" {
  value = aws_api_gateway_method.this.http_method
}
