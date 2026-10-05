# CVEs: known/public vulnerabilities recorded per scope (Personal or a workspace).
#
#   POST  /cves                 -> cves-api  (record a CVE; workspaceId? in the body)
#   GET   /cves                 -> cves-api  (personal CVEs, or ?workspaceId= for a workspace's)
#   GET    /cves/{cveRecordId}   -> cves-api
#   PATCH  /cves/{cveRecordId}   -> cves-api  (mutable fields only)
#   DELETE /cves/{cveRecordId}   -> cves-api  (with its claim and device links)
#   PUT    /cves/{cveRecordId}/devices/{deviceId} -> cves-api  (link a device)
#   DELETE /cves/{cveRecordId}/devices/{deviceId} -> cves-api  (unlink it)
#
# Access checks come from the shared layer (shared.tf).

module "cves_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-cves-api"
  source_dir    = "../../../services/lambdas/cves-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  layers        = [aws_lambda_layer_version.shared.arn]

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

# Writes are all TransactWriteItems, authorized by the actions inside them
# (see the create-device note in main.tf): Put (create: METADATA, scope links
# and the CVEID# claim; link: the two device link rows), Update (PATCH, and
# deviceIds/version on link and unlink), Delete (unlink: the two device link
# rows; DELETE: every row of the CVE) and ConditionCheck (the workspace
# record, the caller's membership or ownership, the device's scope). Reads:
# the authorization, link and claim GetItems, the USER#, WORKSPACE# and CVE#
# queries, and BatchGetItem of CVE#/METADATA. No Scan.
resource "aws_iam_policy" "cves_api" {
  name = "${var.name}-lambda-cves-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
      ]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cves_api" {
  role       = module.cves_api_fn.role_name
  policy_arn = aws_iam_policy.cves_api.arn
}

# --- Routes ------------------------------------------------------------------

resource "aws_api_gateway_resource" "cves" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "cves"
}

resource "aws_api_gateway_resource" "cves_record_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.cves.id
  path_part   = "{cveRecordId}"
}

# Path segment only: /cves/{cveRecordId}/devices has no methods of its own.
resource "aws_api_gateway_resource" "cves_record_id_devices" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.cves_record_id.id
  path_part   = "devices"
}

resource "aws_api_gateway_resource" "cves_record_id_devices_device_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.cves_record_id_devices.id
  path_part   = "{deviceId}"
}

locals {
  # Keys double as the Lambda permission statement suffix, so they must be unique.
  cves_routes = {
    "cves-GET" = {
      resource_id = aws_api_gateway_resource.cves.id
      method      = "GET"
      path        = "cves"
    }
    "cves-POST" = {
      resource_id = aws_api_gateway_resource.cves.id
      method      = "POST"
      path        = "cves"
    }
    "cves-id-GET" = {
      resource_id = aws_api_gateway_resource.cves_record_id.id
      method      = "GET"
      path        = "cves/*"
    }
    "cves-id-PATCH" = {
      resource_id = aws_api_gateway_resource.cves_record_id.id
      method      = "PATCH"
      path        = "cves/*"
    }
    "cves-id-DELETE" = {
      resource_id = aws_api_gateway_resource.cves_record_id.id
      method      = "DELETE"
      path        = "cves/*"
    }
    "cves-id-devices-id-PUT" = {
      resource_id = aws_api_gateway_resource.cves_record_id_devices_device_id.id
      method      = "PUT"
      path        = "cves/*/devices/*"
    }
    "cves-id-devices-id-DELETE" = {
      resource_id = aws_api_gateway_resource.cves_record_id_devices_device_id.id
      method      = "DELETE"
      path        = "cves/*/devices/*"
    }
  }

  # One preflight per resource, allowing every method on it (same grouping
  # as workspaces_preflights in workspaces.tf).
  cves_preflights = {
    for key, route in local.cves_routes : key => {
      resource_id = route.resource_id
      methods     = [for k in sort(keys(local.cves_routes)) : local.cves_routes[k].method if local.cves_routes[k].path == route.path]
    }
    if key == sort([for k, r in local.cves_routes : k if r.path == route.path])[0]
  }
}

module "cves_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.cves_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.cves_api_fn.invoke_arn
  lambda_function_name = module.cves_api_fn.function_name
  statement_suffix     = each.key
}

module "cves_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.cves_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

# A preflight is keyed by the first route on its path, which became
# "cves-id-DELETE" when DELETE was added (Stage 3B.2). Moving the existing
# instance updates the OPTIONS method in place instead of replacing it.
moved {
  from = module.cves_preflight["cves-id-GET"]
  to   = module.cves_preflight["cves-id-DELETE"]
}

locals {
  cves_integration_ids = concat(
    [for route in module.cves_route : route.integration_id],
    [for preflight in module.cves_preflight : preflight.integration_id],
  )
}
