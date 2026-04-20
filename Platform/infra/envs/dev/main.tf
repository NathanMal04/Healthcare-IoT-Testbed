# Main infrastructure definitions

# S3 bucket for hosting static web assets
module "web_bucket" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-web"
  project     = var.name
  environment = "dev"
}

# CloudFront distribution for serving web assets from S3 bucket
module "cdn" {
  source = "../../modules/cloudfront"

  s3_bucket_name                 = module.web_bucket.bucket_name
  s3_bucket_regional_domain_name = module.web_bucket.bucket_regional_domain_name
  s3_bucket_arn                  = module.web_bucket.bucket_arn
  project                        = var.name
  environment                    = "dev"

   aliases             = [var.domain_name, "www.${var.domain_name}"]
  acm_certificate_arn = aws_acm_certificate.frontend.arn
}

# Cognito User Pool for authentication
module "auth" {
  source = "../../modules/cognito"

  pool_name     = "${var.name}-users"
  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls

  post_confirmation_lambda_arn = module.post_confirmation_create_user_fn.function_arn

  project       = var.name
  environment   = "dev"
}

# S3 bucket for general data storage
module "data_lake_bucket" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-data-lake"
  project     = var.name
  environment = "dev"

  cors_rules = [{
    allowed_headers = ["*"]
    allowed_methods = ["PUT"]
    allowed_origins = ["https://vzoniq.com", "http://localhost:3000"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }]
}

# Single-table design for all entity metadata (devices, tests, scripts, tools)
module "metadata_table" {
  source = "../../modules/dynamodb"

  table_name = "${var.name}-metadata"

  hash_key  = "pk"
  range_key = "sk"

  attributes = [
    { name = "pk", type = "S" },
    { name = "sk", type = "S" },
  ]

  project     = var.name
  environment = "dev"
}

module "database" {
  source      = "../../modules/dynamodb"
  table_name  = "${var.name}-data"
  hash_key    = "pk"
  range_key   = "sk"

  attributes = [
    { name = "pk", type = "S" },
    { name = "sk", type = "S" },
  ]

  project     = var.name
  environment = "dev"
}

module "users_table" {
  source = "../../modules/dynamodb"

  table_name = "${var.name}-users"

  hash_key  = "userId"
  range_key = null

  attributes = [
    { name = "userId", type = "S" }
  ]

  project     = var.name
  environment = "dev"
}



module "post_confirmation_create_user_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-post-confirmation-create-user"
  source_dir    = "../../../services/lambdas/post-confirmation-create-user"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]

  environment_variables = {
    USERS_TABLE_NAME = module.users_table.table_name
  }

  project     = var.name
  environment = "dev"
}

resource "aws_lambda_permission" "allow_cognito_post_confirmation" {
  statement_id  = "AllowCognitoPostConfirmationInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.post_confirmation_create_user_fn.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.auth.user_pool_arn
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
        module.metadata_table.table_arn,
        "${module.metadata_table.table_arn}/index/*",
        module.users_table.table_arn,
        "${module.users_table.table_arn}/index/*"
      ]
    }]
  })
}

resource "aws_iam_policy" "lambda_s3_uploads" {
  name = "${var.name}-lambda-s3-uploads"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject"
      ]
      Resource = "${module.data_lake_bucket.bucket_arn}/devices/*"
    }]
  })
}

module "uploads_presign_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-uploads-presign"
  source_dir    = "../../../services/lambdas/uploads-presign"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  additional_policy_arns = [
    aws_iam_policy.lambda_dynamodb.arn,
    aws_iam_policy.lambda_s3_uploads.arn,
  ]

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    DATA_LAKE_BUCKET    = module.data_lake_bucket.bucket_name
    PRESIGN_EXPIRES_SEC = "300"
  }

  project     = var.name
  environment = "dev"
}

module "uploads_complete_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-uploads-complete"
  source_dir    = "../../../services/lambdas/uploads-complete"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  additional_policy_arns = [
    aws_iam_policy.lambda_dynamodb.arn,
    aws_iam_policy.lambda_s3_uploads.arn,
  ]

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    DATA_LAKE_BUCKET    = module.data_lake_bucket.bucket_name
  }

  project     = var.name
  environment = "dev"
}

module "api" {
  source = "../../modules/api_gateway"

  api_name                  = "${var.name}-api"
  stage_name                = "dev"
  enable_cognito_authorizer = true
  cognito_user_pool_arn     = module.auth.user_pool_arn
  project                   = var.name
  environment           = "dev"

  # Set deploy = true and uncomment deployment_trigger once you add your first route
  # deploy             = true
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
# 1. Zip-based (Python):
#   module "example_py_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example"
#     source_dir    = "../../services/lambdas/example"
#     handler       = "app.handler"
#     runtime       = "python3.12"
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 2. Container-based (runtime is in the image, no handler/runtime needed):
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
# 3. Durable zip-based (add durable = true to any zip lambda):
#   module "example_durable_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-durable"
#     source_dir    = "../../services/lambdas/example-durable"
#     handler       = "app.handler"
#     runtime       = "python3.12"
#     memory_size   = 512
#     timeout       = 300
#     durable       = true
#     durable_execution_timeout = 900
#     durable_retention_period  = 7
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
#
# 4. Durable container-based (add durable = true to any container lambda):
#   module "example_durable_container_fn" {
#     source        = "../../modules/lambda"
#     function_name = "${var.name}-example-durable-container"
#     package_type  = "Image"
#     image_uri     = "<account_id>.dkr.ecr.us-east-2.amazonaws.com/repo:tag"
#     memory_size   = 1024
#     timeout       = 300
#     durable       = true
#     durable_execution_timeout = 900
#     durable_retention_period  = 7
#     additional_policy_arns = [aws_iam_policy.lambda_dynamodb.arn]
#     project     = var.name
#     environment = "dev"
#   }
