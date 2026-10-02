# Workspaces: shared projects, their members and invitations.
#
#   POST /workspaces                          -> workspaces-api  (create; caller becomes owner)
#   GET  /workspaces                          -> workspaces-api  (caller's workspaces)
#   GET  /workspaces/{workspaceId}            -> workspaces-api  (workspace + members; owners also see invites)
#   POST /workspaces/{workspaceId}/invites    -> workspaces-api  (owner invites by email)
#   GET  /invites                             -> workspaces-api  (invites to the caller's verified email)
#   POST /workspaces/{workspaceId}/accept     -> workspaces-api
#   POST /workspaces/{workspaceId}/decline    -> workspaces-api
#
# Membership checks come from the shared layer (shared.tf).

module "workspaces_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-workspaces-api"
  source_dir    = "../../../services/lambdas/workspaces-api"
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
# (see the create-device note in main.tf): Put (create, invite, accept),
# Delete (accept and decline remove the invitation rows) and ConditionCheck
# (invite re-checks the owner role, accept the workspace record). Reads: the
# membership and invitation GetItems, the USER#, WORKSPACE# and INVITEE#
# queries, and BatchGetItem of WORKSPACE#/METADATA. No Scan or UpdateItem.
resource "aws_iam_policy" "workspaces_api" {
  name = "${var.name}-lambda-workspaces-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem",
        "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
      ]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "workspaces_api" {
  role       = module.workspaces_api_fn.role_name
  policy_arn = aws_iam_policy.workspaces_api.arn
}

# --- Routes ------------------------------------------------------------------

resource "aws_api_gateway_resource" "workspaces" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "workspaces"
}

resource "aws_api_gateway_resource" "workspaces_workspace_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.workspaces.id
  path_part   = "{workspaceId}"
}

resource "aws_api_gateway_resource" "workspaces_workspace_id_action" {
  for_each = toset(["invites", "accept", "decline"])

  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.workspaces_workspace_id.id
  path_part   = each.key
}

resource "aws_api_gateway_resource" "invites" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "invites"
}

locals {
  # Keys double as the Lambda permission statement suffix, so they must be unique.
  workspaces_routes = {
    "workspaces-GET" = {
      resource_id = aws_api_gateway_resource.workspaces.id
      method      = "GET"
      path        = "workspaces"
    }
    "workspaces-POST" = {
      resource_id = aws_api_gateway_resource.workspaces.id
      method      = "POST"
      path        = "workspaces"
    }
    "workspaces-id-GET" = {
      resource_id = aws_api_gateway_resource.workspaces_workspace_id.id
      method      = "GET"
      path        = "workspaces/*"
    }
    "workspaces-id-invites-POST" = {
      resource_id = aws_api_gateway_resource.workspaces_workspace_id_action["invites"].id
      method      = "POST"
      path        = "workspaces/*/invites"
    }
    "workspaces-id-accept-POST" = {
      resource_id = aws_api_gateway_resource.workspaces_workspace_id_action["accept"].id
      method      = "POST"
      path        = "workspaces/*/accept"
    }
    "workspaces-id-decline-POST" = {
      resource_id = aws_api_gateway_resource.workspaces_workspace_id_action["decline"].id
      method      = "POST"
      path        = "workspaces/*/decline"
    }
    "invites-GET" = {
      resource_id = aws_api_gateway_resource.invites.id
      method      = "GET"
      path        = "invites"
    }
  }

  # One preflight per resource, allowing every method on it (same grouping
  # as artifact_preflights in artifacts.tf).
  workspaces_preflights = {
    for key, route in local.workspaces_routes : key => {
      resource_id = route.resource_id
      methods     = [for k in sort(keys(local.workspaces_routes)) : local.workspaces_routes[k].method if local.workspaces_routes[k].path == route.path]
    }
    if key == sort([for k, r in local.workspaces_routes : k if r.path == route.path])[0]
  }
}

module "workspaces_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.workspaces_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.workspaces_api_fn.invoke_arn
  lambda_function_name = module.workspaces_api_fn.function_name
  statement_suffix     = each.key
}

module "workspaces_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.workspaces_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  workspaces_integration_ids = concat(
    [for route in module.workspaces_route : route.integration_id],
    [for preflight in module.workspaces_preflight : preflight.integration_id],
  )
}
