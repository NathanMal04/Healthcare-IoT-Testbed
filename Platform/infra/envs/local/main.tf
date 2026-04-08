# Local infrastructure — mirrors dev but runs on LocalStack
# CloudFront is excluded (requires LocalStack Pro)

module "web_bucket" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-web"
  project     = var.name
  environment = "local"
}

module "data_lake" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-data-lake"
  project     = var.name
  environment = "local"
}

module "auth" {
  source = "../../modules/cognito"

  pool_name     = "${var.name}-users"
  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls
  project       = var.name
  environment   = "local"
}

# Single-table design for all entity metadata (devices, tests, scripts, tools)
module "metadata" {
  source = "../../modules/dynamodb_local"

  table_name = "${var.name}-metadata"

  hash_key  = "pk"
  range_key = "sk"

  attributes = [
    { name = "pk", type = "S" },
    { name = "sk", type = "S" },
  ]

  project     = var.name
  environment = "local"
}

# Shared IAM policy granting Lambda functions read/write access to DynamoDB
resource "aws_iam_policy" "lambda_dynamodb" {
  name = "${var.name}-lambda-dynamodb"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem"
      ]
      Resource = [
        module.metadata.table_arn,
        "${module.metadata.table_arn}/index/*"
      ]
    }]
  })
}

module "api" {
  source = "../../modules/api_gateway"

  api_name                  = "${var.name}-api"
  stage_name                = "local"
  enable_cognito_authorizer = true
  cognito_user_pool_arn     = module.auth.user_pool_arn
  project                   = var.name
  environment               = "local"
}

# --- API routes ---
# Uncomment and add routes here just like in dev/main.tf
# They will be deployed to LocalStack instead of AWS.
#
# Example:
#   module "route_health" {
#     source               = "../../modules/api_gateway_route"
#     rest_api_id          = module.api.rest_api_id
#     parent_resource_id   = module.api.root_resource_id
#     execution_arn        = module.api.execution_arn
#     path_part            = "health"
#     http_method          = "GET"
#     lambda_invoke_arn    = module.health_fn.invoke_arn
#     lambda_function_name = module.health_fn.function_name
#   }

# --- Lambda functions ---
# Define Lambda functions here just like in dev/main.tf.
# They will run on LocalStack's Lambda emulator.
#
# Example:
#   module "example_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example"
#     source_dir    = "../../services/lambdas/example"
#     handler       = "index.handler"
#     runtime       = "nodejs20.x"
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     environment_variables = {
#       TABLE_NAME = module.metadata.table_name
#     }
#     project     = var.name
#     environment = "local"
#   }
