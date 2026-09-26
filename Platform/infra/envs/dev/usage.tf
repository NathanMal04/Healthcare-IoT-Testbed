# Step 2c: metering, budgets and cost caps.
#
#   GET /usage?period=YYYY-MM   usage-api   (budget + ledger)
#
# usage-meter receives the CodeBuild (builds.tf) and Batch (runs.tf) state
# change events and writes provisional ledger rows. run-watchdog runs every
# 5 minutes and stops runs that reach their cost cap or the owner's budget.

module "usage_meter_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-usage-meter"
  source_dir    = "../../../services/lambdas/usage-meter"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  environment_variables = {
    METADATA_TABLE_NAME   = module.metadata_table.table_name
    PRICING               = local.pricing
    DEFAULT_MONTHLY_LIMIT = var.default_monthly_limit
  }

  project     = var.name
  environment = "dev"
}

module "run_watchdog_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-run-watchdog"
  source_dir    = "../../../services/lambdas/run-watchdog"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  timeout       = 120

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    PRICING             = local.pricing
  }

  project     = var.name
  environment = "dev"
}

module "usage_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-usage-api"
  source_dir    = "../../../services/lambdas/usage-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  environment_variables = {
    METADATA_TABLE_NAME   = module.metadata_table.table_name
    DEFAULT_MONTHLY_LIMIT = var.default_monthly_limit
  }

  project     = var.name
  environment = "dev"
}

resource "aws_iam_policy" "usage_meter" {
  name = "${var.name}-lambda-usage-meter"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect   = "Allow"
        Action   = "codebuild:BatchGetBuilds"
        Resource = aws_codebuild_project.images.arn
      },
    ]
  })
}

resource "aws_iam_policy" "run_watchdog" {
  name = "${var.name}-lambda-run-watchdog"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect   = "Allow"
        Action   = "batch:TerminateJob"
        Resource = "arn:aws:batch:${var.aws_region}:${local.account_id}:job/*"
      },
    ]
  })
}

resource "aws_iam_policy" "usage_api" {
  name = "${var.name}-lambda-usage-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "usage_meter" {
  role       = module.usage_meter_fn.role_name
  policy_arn = aws_iam_policy.usage_meter.arn
}

resource "aws_iam_role_policy_attachment" "run_watchdog" {
  role       = module.run_watchdog_fn.role_name
  policy_arn = aws_iam_policy.run_watchdog.arn
}

resource "aws_iam_role_policy_attachment" "usage_api" {
  role       = module.usage_api_fn.role_name
  policy_arn = aws_iam_policy.usage_api.arn
}

# --- Event wiring --------------------------------------------------------------------

resource "aws_cloudwatch_event_target" "usage_builds" {
  rule = aws_cloudwatch_event_rule.builds.name
  arn  = module.usage_meter_fn.function_arn
}

resource "aws_cloudwatch_event_target" "usage_jobs" {
  rule = aws_cloudwatch_event_rule.jobs.name
  arn  = module.usage_meter_fn.function_arn
}

resource "aws_lambda_permission" "usage_builds" {
  statement_id  = "AllowEventBridge-builds"
  action        = "lambda:InvokeFunction"
  function_name = module.usage_meter_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.builds.arn
}

resource "aws_lambda_permission" "usage_jobs" {
  statement_id  = "AllowEventBridge-jobs"
  action        = "lambda:InvokeFunction"
  function_name = module.usage_meter_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.jobs.arn
}

resource "aws_cloudwatch_event_rule" "watchdog" {
  name                = "${var.name}-run-watchdog"
  description         = "Stop runs over their cost cap or the owner's budget"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "watchdog" {
  rule = aws_cloudwatch_event_rule.watchdog.name
  arn  = module.run_watchdog_fn.function_arn
}

resource "aws_lambda_permission" "watchdog" {
  statement_id  = "AllowEventBridge-watchdog"
  action        = "lambda:InvokeFunction"
  function_name = module.run_watchdog_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog.arn
}

# --- Route -----------------------------------------------------------------------------

resource "aws_api_gateway_resource" "usage" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "usage"
}

module "usage_route" {
  source = "../../modules/api_lambda_method"

  rest_api_id          = module.api.rest_api_id
  resource_id          = aws_api_gateway_resource.usage.id
  execution_arn        = module.api.execution_arn
  http_method          = "GET"
  route_path           = "usage"
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.usage_api_fn.invoke_arn
  lambda_function_name = module.usage_api_fn.function_name
  statement_suffix     = "usage-GET"
}

module "usage_preflight" {
  source = "../../modules/api_cors_preflight"

  rest_api_id     = module.api.rest_api_id
  resource_id     = aws_api_gateway_resource.usage.id
  allowed_methods = ["GET"]
}

locals {
  usage_integration_ids = [module.usage_route.integration_id, module.usage_preflight.integration_id]
}
