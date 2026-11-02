# RE Notebook: each device's reverse-engineering notebook (sections of
# research entries), served by re-notebook-api under /devices/{deviceId}.
#
#   GET    /devices/{deviceId}/notebook
#   POST   /devices/{deviceId}/notebook/sections
#   PATCH  /devices/{deviceId}/notebook/sections/{sectionId}
#   DELETE /devices/{deviceId}/notebook/sections/{sectionId}      (empty sections only)
#   PUT    /devices/{deviceId}/notebook/section-order
#   POST   /devices/{deviceId}/notebook/sections/{sectionId}/entries
#   PUT    /devices/{deviceId}/notebook/sections/{sectionId}/entry-order
#   GET    /devices/{deviceId}/notebook/entries/{entryId}
#   PATCH  /devices/{deviceId}/notebook/entries/{entryId}
#   DELETE /devices/{deviceId}/notebook/entries/{entryId}          (soft delete)
#   PUT    /devices/{deviceId}/notebook/entries/{entryId}/content  (autosave)
#   POST   /devices/{deviceId}/notebook/entries/{entryId}/move
#
# Access checks come from the shared layer (shared.tf): the device-edit rule.

module "re_notebook_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-re-notebook-api"
  source_dir    = "../../../services/lambdas/re-notebook-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  layers        = [aws_lambda_layer_version.shared.arn]

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

# Writes are all TransactWriteItems, authorized by the actions inside them:
# Put (new METADATA, sections, entries and their content), Update (titles,
# order lists, content, soft deletes), Delete (an empty section) and
# ConditionCheck (the device's scope and the caller's membership or
# ownership, in every write). Reads: the authorization GetItems, the
# notebook's GetItems and its SECTION#/ENTRY# queries. No Scan.
resource "aws_iam_policy" "re_notebook_api" {
  name = "${var.name}-lambda-re-notebook-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:Query",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
      ]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "re_notebook_api" {
  role       = module.re_notebook_api_fn.role_name
  policy_arn = aws_iam_policy.re_notebook_api.arn
}

# --- Routes ------------------------------------------------------------------

resource "aws_api_gateway_resource" "re_notebook" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.devices_device_id.id
  path_part   = "notebook"
}

resource "aws_api_gateway_resource" "re_notebook_sections" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook.id
  path_part   = "sections"
}

resource "aws_api_gateway_resource" "re_notebook_section_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_sections.id
  path_part   = "{sectionId}"
}

resource "aws_api_gateway_resource" "re_notebook_section_entries" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_section_id.id
  path_part   = "entries"
}

resource "aws_api_gateway_resource" "re_notebook_entry_order" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_section_id.id
  path_part   = "entry-order"
}

resource "aws_api_gateway_resource" "re_notebook_section_order" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook.id
  path_part   = "section-order"
}

# Path segment only: /notebook/entries has no methods of its own.
resource "aws_api_gateway_resource" "re_notebook_entries" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook.id
  path_part   = "entries"
}

resource "aws_api_gateway_resource" "re_notebook_entry_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_entries.id
  path_part   = "{entryId}"
}

resource "aws_api_gateway_resource" "re_notebook_entry_content" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_entry_id.id
  path_part   = "content"
}

resource "aws_api_gateway_resource" "re_notebook_entry_move" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.re_notebook_entry_id.id
  path_part   = "move"
}

locals {
  re_notebook_routes = {
    "notebook-GET" = {
      resource_id = aws_api_gateway_resource.re_notebook.id
      method      = "GET"
      path        = "devices/*/notebook"
    }
    "notebook-sections-POST" = {
      resource_id = aws_api_gateway_resource.re_notebook_sections.id
      method      = "POST"
      path        = "devices/*/notebook/sections"
    }
    "notebook-sections-id-DELETE" = {
      resource_id = aws_api_gateway_resource.re_notebook_section_id.id
      method      = "DELETE"
      path        = "devices/*/notebook/sections/*"
    }
    "notebook-sections-id-PATCH" = {
      resource_id = aws_api_gateway_resource.re_notebook_section_id.id
      method      = "PATCH"
      path        = "devices/*/notebook/sections/*"
    }
    "notebook-section-order-PUT" = {
      resource_id = aws_api_gateway_resource.re_notebook_section_order.id
      method      = "PUT"
      path        = "devices/*/notebook/section-order"
    }
    "notebook-sections-id-entries-POST" = {
      resource_id = aws_api_gateway_resource.re_notebook_section_entries.id
      method      = "POST"
      path        = "devices/*/notebook/sections/*/entries"
    }
    "notebook-sections-id-entry-order-PUT" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_order.id
      method      = "PUT"
      path        = "devices/*/notebook/sections/*/entry-order"
    }
    "notebook-entries-id-DELETE" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_id.id
      method      = "DELETE"
      path        = "devices/*/notebook/entries/*"
    }
    "notebook-entries-id-GET" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_id.id
      method      = "GET"
      path        = "devices/*/notebook/entries/*"
    }
    "notebook-entries-id-PATCH" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_id.id
      method      = "PATCH"
      path        = "devices/*/notebook/entries/*"
    }
    "notebook-entries-id-content-PUT" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_content.id
      method      = "PUT"
      path        = "devices/*/notebook/entries/*/content"
    }
    "notebook-entries-id-move-POST" = {
      resource_id = aws_api_gateway_resource.re_notebook_entry_move.id
      method      = "POST"
      path        = "devices/*/notebook/entries/*/move"
    }
  }

  # One OPTIONS preflight per path, allowing every method on it (keyed by the
  # path's first route, as in cves.tf).
  re_notebook_preflights = {
    for key, route in local.re_notebook_routes : key => {
      resource_id = route.resource_id
      methods     = [for k in sort(keys(local.re_notebook_routes)) : local.re_notebook_routes[k].method if local.re_notebook_routes[k].path == route.path]
    }
    if key == sort([for k, r in local.re_notebook_routes : k if r.path == route.path])[0]
  }
}

module "re_notebook_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.re_notebook_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.re_notebook_api_fn.invoke_arn
  lambda_function_name = module.re_notebook_api_fn.function_name
  statement_suffix     = each.key
}

module "re_notebook_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.re_notebook_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  re_notebook_integration_ids = concat(
    [for route in module.re_notebook_route : route.integration_id],
    [for preflight in module.re_notebook_preflight : preflight.integration_id],
  )
}
