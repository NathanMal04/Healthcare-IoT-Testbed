# Device deletion, served by delete-device:
#
#   GET    /devices/{deviceId}/deletion   what a deletion would remove (counts)
#   DELETE /devices/{deviceId}            {"confirmName": "<device name>"}
#
# plus a schedule that finishes deletions a request couldn't (a cleanup that
# failed or ran out of time leaves an ACTIVE#DEVICE_DELETIONS tombstone).
# The rule of who may delete comes from the shared layer
# (testbed_authz.may_delete_device). See DATABASE.md, "Deleting a device".

module "delete_device_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-delete-device"
  source_dir    = "../../../services/lambdas/delete-device"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  layers        = [aws_lambda_layer_version.shared.arn]
  # API requests stop themselves after about 20 s (API Gateway's limit is
  # 29 s); the scheduled sweep uses the rest. LEASE_SECONDS in the function
  # must stay above this.
  timeout = 300

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    DATA_LAKE_BUCKET    = module.data_lake_bucket.bucket_name
  }

  project     = var.name
  environment = "dev"
}

# DynamoDB: GetItem and Query (the device, artifact, CVE, notebook and
# tombstone partitions; no Scan), and TransactWriteItems made of Delete,
# Put (the tombstone), Update (deviceIds of kept artifacts and CVEs, batch
# counters, the tombstone's lease) and ConditionCheck (the caller's role).
# S3: only the device's own prefix and the prefixes of artifacts being
# deleted are listed and deleted.
resource "aws_iam_policy" "delete_device" {
  name = "${var.name}-lambda-delete-device"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:Query",
          "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
        ]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = module.data_lake_bucket.bucket_arn
        Condition = {
          StringLike = { "s3:prefix" = ["artifacts/*", "devices/*"] }
        }
      },
      {
        Effect = "Allow"
        Action = ["s3:DeleteObject"]
        Resource = [
          "${module.data_lake_bucket.bucket_arn}/artifacts/*",
          "${module.data_lake_bucket.bucket_arn}/devices/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "delete_device" {
  role       = module.delete_device_fn.role_name
  policy_arn = aws_iam_policy.delete_device.arn
}

# --- Routes ------------------------------------------------------------------

# DELETE on the existing /devices/{deviceId} resource (its OPTIONS preflight,
# in main.tf, allows DELETE).
module "devices_device_id_delete" {
  source = "../../modules/api_lambda_method"

  rest_api_id          = module.api.rest_api_id
  resource_id          = aws_api_gateway_resource.devices_device_id.id
  execution_arn        = module.api.execution_arn
  http_method          = "DELETE"
  route_path           = "devices/*"
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.delete_device_fn.invoke_arn
  lambda_function_name = module.delete_device_fn.function_name
  statement_suffix     = "devices-id-DELETE"
}

resource "aws_api_gateway_resource" "devices_device_id_deletion" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.devices_device_id.id
  path_part   = "deletion"
}

module "devices_device_id_deletion_get" {
  source = "../../modules/api_lambda_method"

  rest_api_id          = module.api.rest_api_id
  resource_id          = aws_api_gateway_resource.devices_device_id_deletion.id
  execution_arn        = module.api.execution_arn
  http_method          = "GET"
  route_path           = "devices/*/deletion"
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.delete_device_fn.invoke_arn
  lambda_function_name = module.delete_device_fn.function_name
  statement_suffix     = "devices-id-deletion-GET"
}

module "devices_device_id_deletion_preflight" {
  source = "../../modules/api_cors_preflight"

  rest_api_id     = module.api.rest_api_id
  resource_id     = aws_api_gateway_resource.devices_device_id_deletion.id
  allowed_methods = ["GET"]
}

locals {
  device_deletion_integration_ids = [
    module.devices_device_id_delete.integration_id,
    module.devices_device_id_deletion_get.integration_id,
    module.devices_device_id_deletion_preflight.integration_id,
  ]
}

# --- Sweep -------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "delete_device_sweep" {
  name                = "${var.name}-delete-device-sweep"
  description         = "Finishes device deletions whose cleanup a request couldn't complete"
  schedule_expression = "rate(10 minutes)"
}

resource "aws_cloudwatch_event_target" "delete_device_sweep" {
  rule = aws_cloudwatch_event_rule.delete_device_sweep.name
  arn  = module.delete_device_fn.function_arn
}

resource "aws_lambda_permission" "delete_device_sweep" {
  statement_id  = "AllowEventBridge-delete-device-sweep"
  action        = "lambda:InvokeFunction"
  function_name = module.delete_device_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.delete_device_sweep.arn
}
