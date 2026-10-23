# Step 2a: environments and scripts, built into images by CodeBuild.
#
#   GET/POST /modules                                         builds-api
#   GET      /modules/{moduleId}                              builds-api
#   POST     /modules/{moduleId}/versions                     builds-api
#   POST     /modules/{moduleId}/versions/{version}/complete  builds-api
#   GET      /modules/{moduleId}/versions/{version}/download  builds-api
#   GET      /modules/{moduleId}/versions/{version}/log       builds-api
#   GET      /modules/{moduleId}/versions/{version}/packages  builds-api
#   GET/POST /environments                                    builds-api
#   GET      /environments/catalog                            builds-api
#   GET      /environments/{envId}                            builds-api
#   POST     /environments/{envId}/versions                   builds-api
#   GET      /environments/{envId}/versions/{version}/log     builds-api
#   GET      /environments/{envId}/versions/{version}/packages builds-api
#
# CodeBuild "Build State Change" events go to builds-events (status, image
# digest, Batch job definitions) and usage-meter (usage.tf).

data "aws_caller_identity" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  buildkit_dir  = "${path.module}/../../../services/containers/buildkit"
  build_project = "${var.name}-image-build"
}

# --- ECR ---------------------------------------------------------------------

# One repository for every environment and script image, so shared base
# layers are stored once. Tags are per version and never reused; runs use
# digests.
resource "aws_ecr_repository" "scripts" {
  name                 = "${var.name}-scripts"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_ecr_lifecycle_policy" "scripts" {
  repository = aws_ecr_repository.scripts.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Remove untagged images (failed or superseded pushes)"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
      action       = { type = "expire" }
    }]
  })
}

# Platform images (analysis-base and platform-ghidra), pushed by the
# deploy-images workflow.
resource "aws_ecr_repository" "platform_base" {
  name                 = "${var.name}-platform-base"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_ecr_lifecycle_policy" "platform_base" {
  repository = aws_ecr_repository.platform_base.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent platform images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# --- Buildkit and catalog ----------------------------------------------------------

data "archive_file" "buildkit" {
  type        = "zip"
  source_dir  = local.buildkit_dir
  output_path = "/tmp/${var.name}-buildkit.zip"
}

resource "aws_s3_object" "buildkit" {
  bucket = module.data_lake_bucket.bucket_name
  key    = "platform/buildkit/${data.archive_file.buildkit.output_md5}.zip"
  source = data.archive_file.buildkit.output_path
  etag   = data.archive_file.buildkit.output_md5
}

resource "aws_s3_object" "catalog" {
  bucket       = module.data_lake_bucket.bucket_name
  key          = "platform/catalog.json"
  source       = "${local.buildkit_dir}/catalog.json"
  etag         = filemd5("${local.buildkit_dir}/catalog.json")
  content_type = "application/json"
}

# --- CodeBuild -------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "builds" {
  name              = "/aws/codebuild/${local.build_project}"
  retention_in_days = 30

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_iam_role" "codebuild" {
  name = "${var.name}-image-build-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Deliberately no S3 access at all: sources, the buildkit and the package
# lists move through presigned URLs that builds-api passes to each build, so
# a user's Dockerfile that somehow reached these credentials still couldn't
# read anyone's files.
resource "aws_iam_role_policy" "codebuild" {
  name = "${var.name}-image-build"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.builds.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
        ]
        Resource = aws_ecr_repository.scripts.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.platform_base.arn
      },
    ]
  })
}

resource "aws_codebuild_project" "images" {
  name                   = local.build_project
  description            = "Builds environment and script images (see services/containers/buildkit)"
  service_role           = aws_iam_role.codebuild.arn
  build_timeout          = 60
  queued_timeout         = 120
  concurrent_build_limit = 10

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    type            = "LINUX_CONTAINER"
    compute_type    = "BUILD_GENERAL1_MEDIUM"
    image           = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    privileged_mode = true

    environment_variable {
      name  = "IMAGE_REPO"
      value = aws_ecr_repository.scripts.repository_url
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = file("${local.buildkit_dir}/buildspec.yml")
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.builds.name
    }
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# --- Lambdas ---------------------------------------------------------------------

module "builds_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-builds-api"
  source_dir    = "../../../services/lambdas/builds-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 512

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    DATA_LAKE_BUCKET    = module.data_lake_bucket.bucket_name
    CODEBUILD_PROJECT   = aws_codebuild_project.images.name
    BUILDKIT_KEY        = aws_s3_object.buildkit.key
    CATALOG_KEY         = aws_s3_object.catalog.key
  }

  project     = var.name
  environment = "dev"
}

module "builds_events_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-builds-events"
  source_dir    = "../../../services/lambdas/builds-events"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"

  environment_variables = {
    METADATA_TABLE_NAME      = module.metadata_table.table_name
    BATCH_EXECUTION_ROLE_ARN = aws_iam_role.batch_execution.arn
    RUN_LOG_GROUP            = aws_cloudwatch_log_group.runs.name
    JOBDEF_PREFIX            = var.name
    HEAVY_ENABLED            = tostring(var.enable_heavy_class)
  }

  project     = var.name
  environment = "dev"
}

resource "aws_iam_policy" "builds_api" {
  name = "${var.name}-lambda-builds-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        # Source uploads (presigned POST), validation reads and the source
        # URL handed to the build.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${module.data_lake_bucket.bucket_arn}/scripts/*"
      },
      {
        # Package lists: the build uploads them with a POST presigned by
        # this role, and the packages endpoint reads them back.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${module.data_lake_bucket.bucket_arn}/builds/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${module.data_lake_bucket.bucket_arn}/platform/*"
      },
      {
        Effect   = "Allow"
        Action   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"]
        Resource = aws_codebuild_project.images.arn
      },
      {
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "${aws_cloudwatch_log_group.builds.arn}:*"
      },
    ]
  })
}

resource "aws_iam_policy" "builds_events" {
  name = "${var.name}-lambda-builds-events"

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
        Action   = "codebuild:BatchGetBuilds"
        Resource = aws_codebuild_project.images.arn
      },
      {
        Effect   = "Allow"
        Action   = ["batch:RegisterJobDefinition", "batch:TagResource"]
        Resource = "arn:aws:batch:${var.aws_region}:${local.account_id}:job-definition/${var.name}-mod-*"
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.batch_execution.arn
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "builds_api" {
  role       = module.builds_api_fn.role_name
  policy_arn = aws_iam_policy.builds_api.arn
}

resource "aws_iam_role_policy_attachment" "builds_events" {
  role       = module.builds_events_fn.role_name
  policy_arn = aws_iam_policy.builds_events.arn
}

# --- Build events ------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "builds" {
  name        = "${var.name}-image-builds"
  description = "Image build state changes"
  event_pattern = jsonencode({
    source        = ["aws.codebuild"]
    "detail-type" = ["CodeBuild Build State Change"]
    detail        = { "project-name" = [aws_codebuild_project.images.name] }
  })
}

resource "aws_cloudwatch_event_target" "builds_events" {
  rule = aws_cloudwatch_event_rule.builds.name
  arn  = module.builds_events_fn.function_arn
}

resource "aws_lambda_permission" "builds_events" {
  statement_id  = "AllowEventBridge-builds"
  action        = "lambda:InvokeFunction"
  function_name = module.builds_events_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.builds.arn
}

# --- Routes ------------------------------------------------------------------------

resource "aws_api_gateway_resource" "modules" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "modules"
}

resource "aws_api_gateway_resource" "modules_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.modules.id
  path_part   = "{moduleId}"
}

resource "aws_api_gateway_resource" "modules_id_versions" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.modules_id.id
  path_part   = "versions"
}

resource "aws_api_gateway_resource" "modules_id_versions_n" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.modules_id_versions.id
  path_part   = "{version}"
}

resource "aws_api_gateway_resource" "modules_version_action" {
  for_each    = toset(["complete", "download", "log", "packages"])
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.modules_id_versions_n.id
  path_part   = each.value
}

resource "aws_api_gateway_resource" "environments" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "environments"
}

resource "aws_api_gateway_resource" "environments_catalog" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.environments.id
  path_part   = "catalog"
}

resource "aws_api_gateway_resource" "environments_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.environments.id
  path_part   = "{envId}"
}

resource "aws_api_gateway_resource" "environments_id_versions" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.environments_id.id
  path_part   = "versions"
}

resource "aws_api_gateway_resource" "environments_id_versions_n" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.environments_id_versions.id
  path_part   = "{version}"
}

resource "aws_api_gateway_resource" "environments_version_action" {
  for_each    = toset(["log", "packages"])
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.environments_id_versions_n.id
  path_part   = each.value
}

locals {
  # `res` names the resource; it keys the preflights, which need keys that
  # are known at plan time (resource ids aren't).
  builds_routes = {
    "modules-GET"                   = { res = "modules", resource_id = aws_api_gateway_resource.modules.id, method = "GET", path = "modules" }
    "modules-POST"                  = { res = "modules", resource_id = aws_api_gateway_resource.modules.id, method = "POST", path = "modules" }
    "modules-id-GET"                = { res = "modules-id", resource_id = aws_api_gateway_resource.modules_id.id, method = "GET", path = "modules/*" }
    "modules-id-versions-POST"      = { res = "modules-versions", resource_id = aws_api_gateway_resource.modules_id_versions.id, method = "POST", path = "modules/*/versions" }
    "modules-version-complete-POST" = { res = "modules-complete", resource_id = aws_api_gateway_resource.modules_version_action["complete"].id, method = "POST", path = "modules/*/versions/*/complete" }
    "modules-version-download-GET"  = { res = "modules-download", resource_id = aws_api_gateway_resource.modules_version_action["download"].id, method = "GET", path = "modules/*/versions/*/download" }
    "modules-version-log-GET"       = { res = "modules-log", resource_id = aws_api_gateway_resource.modules_version_action["log"].id, method = "GET", path = "modules/*/versions/*/log" }
    "modules-version-packages-GET"  = { res = "modules-packages", resource_id = aws_api_gateway_resource.modules_version_action["packages"].id, method = "GET", path = "modules/*/versions/*/packages" }
    "envs-GET"                      = { res = "envs", resource_id = aws_api_gateway_resource.environments.id, method = "GET", path = "environments" }
    "envs-POST"                     = { res = "envs", resource_id = aws_api_gateway_resource.environments.id, method = "POST", path = "environments" }
    "envs-catalog-GET"              = { res = "envs-catalog", resource_id = aws_api_gateway_resource.environments_catalog.id, method = "GET", path = "environments/catalog" }
    "envs-id-GET"                   = { res = "envs-id", resource_id = aws_api_gateway_resource.environments_id.id, method = "GET", path = "environments/*" }
    "envs-id-versions-POST"         = { res = "envs-versions", resource_id = aws_api_gateway_resource.environments_id_versions.id, method = "POST", path = "environments/*/versions" }
    "envs-version-log-GET"          = { res = "envs-log", resource_id = aws_api_gateway_resource.environments_version_action["log"].id, method = "GET", path = "environments/*/versions/*/log" }
    "envs-version-packages-GET"     = { res = "envs-packages", resource_id = aws_api_gateway_resource.environments_version_action["packages"].id, method = "GET", path = "environments/*/versions/*/packages" }
  }

  # One preflight per resource, listing every method on it.
  builds_preflights = {
    for res in distinct([for r in values(local.builds_routes) : r.res]) : res => {
      resource_id = [for r in values(local.builds_routes) : r.resource_id if r.res == res][0]
      methods     = [for r in values(local.builds_routes) : r.method if r.res == res]
    }
  }
}

module "builds_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.builds_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.builds_api_fn.invoke_arn
  lambda_function_name = module.builds_api_fn.function_name
  statement_suffix     = each.key
}

module "builds_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.builds_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  builds_integration_ids = concat(
    [for r in module.builds_route : r.integration_id],
    [for p in module.builds_preflight : p.integration_id],
  )
}
