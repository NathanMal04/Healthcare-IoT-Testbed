# Artifacts: uploads of any file type (firmware, pcap, log, binary, other),
# single presigned POST up to 25 MiB and multipart up to 5 GiB, with
# per-file device links, tags and upload batches.
#
#   POST /artifacts/presign                  -> artifacts-presign  (batch of up to 100 files)
#   POST /artifacts/{artifactId}/parts       -> artifacts-presign  (multipart part URLs)
#   POST /artifacts/{artifactId}/retry       -> artifacts-presign  (new upload attempt)
#   POST /artifacts/complete                 -> artifacts-complete (batch of up to 100)
#   GET  /artifacts                          -> artifacts-list     (?type, tag, batchId, runId, limit, nextToken)
#   GET  /artifacts/batches                  -> artifacts-list     (recent upload batches)
#   GET  /devices/{deviceId}/artifacts       -> artifacts-list     (?type, tag, limit, nextToken)
#   GET  /artifacts/{artifactId}             -> artifacts-get
#   GET  /artifacts/{artifactId}/download    -> artifacts-get
#   PATCH /artifacts/{artifactId}            -> artifacts-update   (firmware reverseEngineeringStatus)
#
# artifacts-verify has no route: artifacts-complete invokes it asynchronously
# to check the full SHA-256 of multipart uploads.

locals {
  artifact_objects_arn = "${module.data_lake_bucket.bucket_arn}/artifacts/*"
}

# --- Lambdas -----------------------------------------------------------------

module "artifacts_presign_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-presign"
  source_dir    = "../../../services/lambdas/artifacts-presign"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 512

  environment_variables = {
    METADATA_TABLE_NAME     = module.metadata_table.table_name
    DATA_LAKE_BUCKET        = module.data_lake_bucket.bucket_name
    PRESIGN_EXPIRES_SEC     = "3600"
    PART_URL_EXPIRES_SEC    = "900"
    MAX_ARTIFACT_SIZE_BYTES = "5368709120"
    SINGLE_UPLOAD_MAX_BYTES = "26214400"
    VERIFY_STALE_SEC        = "1200"
  }

  project     = var.name
  environment = "dev"
}

module "artifacts_complete_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-complete"
  source_dir    = "../../../services/lambdas/artifacts-complete"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 512

  environment_variables = {
    METADATA_TABLE_NAME  = module.metadata_table.table_name
    VERIFY_FUNCTION_NAME = module.artifacts_verify_fn.function_name
    VERIFY_STALE_SEC     = "1200"
  }

  project     = var.name
  environment = "dev"
}

# Streams up to 5 GiB through SHA-256. 1769 MB is one full vCPU.
module "artifacts_verify_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-verify"
  source_dir    = "../../../services/lambdas/artifacts-verify"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 1769
  timeout       = 900

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

module "artifacts_list_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-list"
  source_dir    = "../../../services/lambdas/artifacts-list"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 256

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

module "artifacts_get_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-get"
  source_dir    = "../../../services/lambdas/artifacts-get"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  environment_variables = {
    METADATA_TABLE_NAME  = module.metadata_table.table_name
    DOWNLOAD_EXPIRES_SEC = "300"
  }

  project     = var.name
  environment = "dev"
}

module "artifacts_update_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-artifacts-update"
  source_dir    = "../../../services/lambdas/artifacts-update"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

# --- Scoped IAM, one policy per Lambda ---------------------------------------
#
# TransactWriteItems needs no grant of its own: the Put/Update items inside it
# are authorized by PutItem/UpdateItem (see the create-device note in main.tf).
# Presigned URLs are signed with the Lambda's credentials, so the Lambda must
# hold the S3 permission the browser's request will need.

resource "aws_iam_policy" "artifacts_presign" {
  name = "${var.name}-lambda-artifacts-presign"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        # PutObject covers the presigned POST, CreateMultipartUpload and
        # UploadPart; PutObjectTagging is needed because both upload paths
        # set the upload-state=pending tag.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectTagging", "s3:AbortMultipartUpload"]
        Resource = local.artifact_objects_arn
      },
    ]
  })
}

resource "aws_iam_policy" "artifacts_complete" {
  name = "${var.name}-lambda-artifacts-complete"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        # GetObject covers HeadObject; PutObject covers
        # CompleteMultipartUpload. s3:ListBucket is deliberately not granted
        # (see complete-firmware).
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:ListMultipartUploadParts",
        ]
        Resource = local.artifact_objects_arn
      },
      {
        # Migrated firmware that was still pending keeps its original
        # devices/.../firmware key, and completing it reads and tags that object.
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObjectTagging"]
        Resource = "${module.data_lake_bucket.bucket_arn}/devices/*/firmware/*"
      },
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.artifacts_verify_fn.function_arn
      },
    ]
  })
}

resource "aws_iam_policy" "artifacts_verify" {
  name = "${var.name}-lambda-artifacts-verify"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObjectTagging"]
        Resource = local.artifact_objects_arn
      },
    ]
  })
}

resource "aws_iam_policy" "artifacts_list" {
  name = "${var.name}-lambda-artifacts-list"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_policy" "artifacts_get" {
  name = "${var.name}-lambda-artifacts-get"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = module.metadata_table.table_arn
      },
      {
        # Migrated firmware artifacts keep their original devices/.../firmware keys.
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          local.artifact_objects_arn,
          "${module.data_lake_bucket.bucket_arn}/devices/*/firmware/*",
        ]
      },
    ]
  })
}

# Reads the caller's USER#/ARTIFACT# link and ARTIFACT#/METADATA, and sets
# reverseEngineeringStatus on firmware. No S3 access.
resource "aws_iam_policy" "artifacts_update" {
  name = "${var.name}-lambda-artifacts-update"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "artifacts_presign" {
  role       = module.artifacts_presign_fn.role_name
  policy_arn = aws_iam_policy.artifacts_presign.arn
}

resource "aws_iam_role_policy_attachment" "artifacts_complete" {
  role       = module.artifacts_complete_fn.role_name
  policy_arn = aws_iam_policy.artifacts_complete.arn
}

resource "aws_iam_role_policy_attachment" "artifacts_verify" {
  role       = module.artifacts_verify_fn.role_name
  policy_arn = aws_iam_policy.artifacts_verify.arn
}

resource "aws_iam_role_policy_attachment" "artifacts_list" {
  role       = module.artifacts_list_fn.role_name
  policy_arn = aws_iam_policy.artifacts_list.arn
}

resource "aws_iam_role_policy_attachment" "artifacts_get" {
  role       = module.artifacts_get_fn.role_name
  policy_arn = aws_iam_policy.artifacts_get.arn
}

resource "aws_iam_role_policy_attachment" "artifacts_update" {
  role       = module.artifacts_update_fn.role_name
  policy_arn = aws_iam_policy.artifacts_update.arn
}

# --- Routes ------------------------------------------------------------------

resource "aws_api_gateway_resource" "artifacts" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "artifacts"
}

resource "aws_api_gateway_resource" "artifacts_presign" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts.id
  path_part   = "presign"
}

resource "aws_api_gateway_resource" "artifacts_batches" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts.id
  path_part   = "batches"
}

resource "aws_api_gateway_resource" "artifacts_complete" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts.id
  path_part   = "complete"
}

resource "aws_api_gateway_resource" "artifacts_artifact_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts.id
  path_part   = "{artifactId}"
}

resource "aws_api_gateway_resource" "artifacts_artifact_id_parts" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts_artifact_id.id
  path_part   = "parts"
}

resource "aws_api_gateway_resource" "artifacts_artifact_id_retry" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts_artifact_id.id
  path_part   = "retry"
}

resource "aws_api_gateway_resource" "artifacts_artifact_id_download" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.artifacts_artifact_id.id
  path_part   = "download"
}

resource "aws_api_gateway_resource" "devices_device_id_artifacts" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.devices_device_id.id
  path_part   = "artifacts"
}

locals {
  # One entry per method. Keys double as the Lambda permission statement
  # suffix, so they must be unique.
  artifact_routes = {
    "artifacts-GET" = {
      resource_id = aws_api_gateway_resource.artifacts.id
      method      = "GET"
      path        = "artifacts"
      fn          = module.artifacts_list_fn
    }
    "artifacts-presign-POST" = {
      resource_id = aws_api_gateway_resource.artifacts_presign.id
      method      = "POST"
      path        = "artifacts/presign"
      fn          = module.artifacts_presign_fn
    }
    "artifacts-batches-GET" = {
      resource_id = aws_api_gateway_resource.artifacts_batches.id
      method      = "GET"
      path        = "artifacts/batches"
      fn          = module.artifacts_list_fn
    }
    "artifacts-complete-POST" = {
      resource_id = aws_api_gateway_resource.artifacts_complete.id
      method      = "POST"
      path        = "artifacts/complete"
      fn          = module.artifacts_complete_fn
    }
    "artifacts-id-GET" = {
      resource_id = aws_api_gateway_resource.artifacts_artifact_id.id
      method      = "GET"
      path        = "artifacts/*"
      fn          = module.artifacts_get_fn
    }
    "artifacts-id-parts-POST" = {
      resource_id = aws_api_gateway_resource.artifacts_artifact_id_parts.id
      method      = "POST"
      path        = "artifacts/*/parts"
      fn          = module.artifacts_presign_fn
    }
    "artifacts-id-retry-POST" = {
      resource_id = aws_api_gateway_resource.artifacts_artifact_id_retry.id
      method      = "POST"
      path        = "artifacts/*/retry"
      fn          = module.artifacts_presign_fn
    }
    "artifacts-id-PATCH" = {
      resource_id = aws_api_gateway_resource.artifacts_artifact_id.id
      method      = "PATCH"
      path        = "artifacts/*"
      fn          = module.artifacts_update_fn
    }
    "artifacts-id-download-GET" = {
      resource_id = aws_api_gateway_resource.artifacts_artifact_id_download.id
      method      = "GET"
      path        = "artifacts/*/download"
      fn          = module.artifacts_get_fn
    }
    "devices-id-artifacts-GET" = {
      resource_id = aws_api_gateway_resource.devices_device_id_artifacts.id
      method      = "GET"
      path        = "devices/*/artifacts"
      fn          = module.artifacts_list_fn
    }
  }

  # One preflight per resource, allowing every method on it. Routes are
  # grouped by path (a static string, unlike resource_id, so the for_each
  # keys are known at plan time), and each preflight keeps the key of the
  # first route on its path, so adding a method to a resource doesn't
  # replace its existing preflight.
  artifact_preflights = {
    for key, route in local.artifact_routes : key => {
      resource_id = route.resource_id
      methods     = [for k in sort(keys(local.artifact_routes)) : local.artifact_routes[k].method if local.artifact_routes[k].path == route.path]
    }
    if key == sort([for k, r in local.artifact_routes : k if r.path == route.path])[0]
  }
}

module "artifact_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.artifact_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = each.value.fn.invoke_arn
  lambda_function_name = each.value.fn.function_name
  statement_suffix     = each.key
}

module "artifact_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.artifact_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  artifact_integration_ids = concat(
    [for route in module.artifact_route : route.integration_id],
    [for preflight in module.artifact_preflight : preflight.integration_id],
  )
}
