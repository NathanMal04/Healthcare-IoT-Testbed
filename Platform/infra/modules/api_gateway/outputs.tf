output "rest_api_id" {
  value = aws_api_gateway_rest_api.this.id
}

output "root_resource_id" {
  value = aws_api_gateway_rest_api.this.root_resource_id
}

output "execution_arn" {
  value = aws_api_gateway_rest_api.this.execution_arn
}

output "invoke_url" {
  value = var.deploy ? aws_api_gateway_stage.this[0].invoke_url : null
}

output "cognito_authorizer_id" {
  value = var.enable_cognito_authorizer ? aws_api_gateway_authorizer.cognito[0].id : null
}
