# Main infrastructure definitions

module "web_bucket" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-web"
  project     = var.name
  environment = "dev"
}

module "cdn" {
  source = "../../modules/cloudfront"

  s3_bucket_name                 = module.web_bucket.bucket_name
  s3_bucket_regional_domain_name = module.web_bucket.bucket_regional_domain_name
  s3_bucket_arn                  = module.web_bucket.bucket_arn
  project                        = var.name
  environment                    = "dev"
}

module "auth" {
  source = "../../modules/cognito"

  pool_name     = "${var.name}-users"
  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls
  project       = var.name
  environment   = "dev"
}

module "database" {
  source = "../../modules/dynamodb"

  table_name = "${var.name}-data"
  hash_key   = var.dynamodb_hash_key
  range_key  = var.dynamodb_range_key
  attributes = var.dynamodb_attributes
  project    = var.name
  environment = "dev"
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
        module.database.table_arn,
        "${module.database.table_arn}/index/*"
      ]
    }]
  })
}

module "api" {
  source = "../../modules/api_gateway"

  api_name                  = "${var.name}-api"
  stage_name                = "dev"
  enable_cognito_authorizer = true
  cognito_user_pool_arn     = module.auth.user_pool_arn
  project                   = var.name
  environment           = "dev"

  # Add each route's resource_id here to trigger redeployment on changes
  # deployment_trigger = sha1(jsonencode([
  #   module.route_example.resource_id,
  # ]))
}

# --- API routes ---
# Each route maps a path + method to a Lambda function.
#
# Public route (no auth):
#   module "route_health" {
#     source             = "../../modules/api_gateway_route"
#     rest_api_id        = module.api.rest_api_id
#     parent_resource_id = module.api.root_resource_id
#     execution_arn      = module.api.execution_arn
#     path_part          = "health"
#     http_method        = "GET"
#     lambda_invoke_arn  = module.health_fn.invoke_arn
#     lambda_function_name = module.health_fn.function_name
#   }
#
# Protected route (Cognito auth):
#   module "route_users" {
#     source             = "../../modules/api_gateway_route"
#     rest_api_id        = module.api.rest_api_id
#     parent_resource_id = module.api.root_resource_id
#     execution_arn      = module.api.execution_arn
#     path_part          = "users"
#     http_method        = "GET"
#     authorization      = "COGNITO_USER_POOLS"
#     authorizer_id      = module.api.cognito_authorizer_id
#     lambda_invoke_arn  = module.get_users_fn.invoke_arn
#     lambda_function_name = module.get_users_fn.function_name
#   }

# --- Lambda functions ---
#
# Supported runtimes (set via "runtime" variable):
#   Node.js:  "nodejs18.x", "nodejs20.x", "nodejs22.x"
#   Python:   "python3.11", "python3.12", "python3.13"
#   Container images ignore runtime — it's baked into the image.
#
# Supported handlers (set via "handler" variable):
#   Node.js:  "index.handler"     (exports.handler in index.js)
#   Python:   "app.handler"       (def handler in app.py)
#
# 1. Zip-based (Node.js):
#   module "example_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example"
#     source_dir    = "../../services/lambdas/example"
#     handler       = "index.handler"
#     runtime       = "nodejs20.x"
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 2. Zip-based (Python):
#   module "example_py_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-py"
#     source_dir    = "../../services/lambdas/example-py"
#     handler       = "app.handler"
#     runtime       = "python3.12"
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 3. Container-based (runtime is in the image, no handler/runtime needed):
#   module "example_container_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-container"
#     package_type  = "Image"
#     image_uri     = "<account_id>.dkr.ecr.us-east-2.amazonaws.com/repo:tag"
#     memory_size   = 1024
#     timeout       = 300
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 4. Durable zip-based (add durable = true to any zip lambda):
#   module "example_durable_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-durable"
#     source_dir    = "../../services/lambdas/example-durable"
#     handler       = "index.handler"
#     runtime       = "nodejs22.x"
#     memory_size   = 512
#     durable       = true
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 5. Durable container-based (add durable = true to any container lambda):
#   module "example_durable_container_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-durable-container"
#     package_type  = "Image"
#     image_uri     = "<account_id>.dkr.ecr.us-east-2.amazonaws.com/repo:tag"
#     memory_size   = 1024
#     durable       = true
#     durable_execution_timeout = 900
#     durable_retention_period  = 7
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
