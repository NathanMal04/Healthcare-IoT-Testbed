resource "aws_api_gateway_rest_api" "this" {
  name = var.api_name

  tags = {
    Project = var.project
    Env     = var.environment
  }
}

resource "aws_api_gateway_authorizer" "cognito" {
  count         = var.enable_cognito_authorizer ? 1 : 0
  name          = "${var.api_name}-cognito"
  rest_api_id   = aws_api_gateway_rest_api.this.id
  type          = "COGNITO_USER_POOLS"
  provider_arns = [var.cognito_user_pool_arn]
}

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeployment = var.deployment_trigger
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "this" {
  deployment_id = aws_api_gateway_deployment.this.id
  rest_api_id   = aws_api_gateway_rest_api.this.id
  stage_name    = var.stage_name

  tags = {
    Project = var.project
    Env     = var.environment
  }
}
