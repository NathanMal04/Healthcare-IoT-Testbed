resource "aws_api_gateway_resource" "this" {
  rest_api_id = var.rest_api_id
  parent_id   = var.parent_resource_id
  path_part   = var.path_part
}

resource "aws_api_gateway_method" "this" {
  rest_api_id   = var.rest_api_id
  resource_id   = aws_api_gateway_resource.this.id
  http_method   = var.http_method
  authorization = var.authorization
  authorizer_id = var.authorization == "COGNITO_USER_POOLS" ? var.authorizer_id : null
}

resource "aws_api_gateway_integration" "this" {
  rest_api_id             = var.rest_api_id
  resource_id             = aws_api_gateway_resource.this.id
  http_method             = aws_api_gateway_method.this.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arn
}

resource "aws_lambda_permission" "this" {
  statement_id  = "AllowAPIGateway-${var.path_part}-${var.http_method}"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.execution_arn}/*/${var.http_method}/${var.path_part}"
}
