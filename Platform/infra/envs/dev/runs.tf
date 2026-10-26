# Step 2b: bulk runs on AWS Batch.
#
#   POST /runs/estimate                         runs-api
#   GET/POST /runs                              runs-api
#   GET  /runs/{runId}                          runs-api
#   POST /runs/{runId}/cancel                   runs-api
#   GET  /runs/{runId}/children/{index}/log     runs-api
#
# Jobs run in private subnets with no internet and no IAM role. They reach
# their files only through the private manifest API (runs-manifest), which
# hands out presigned S3 URLs. Batch "Job State Change" events go to
# runs-events (status, settlement) and usage-meter (usage.tf).
#
# The VPC's interface endpoints come and go with demand (network.tf): the
# compute environments are left DISABLED here and only enabled by the
# network-controller Lambda once every endpoint they need is available, so
# submitted jobs wait in RUNNABLE until then.

locals {
  pricing = jsonencode({
    fargate         = { vcpuHour = 0.04048, gbHour = 0.004445 }
    fargateSpot     = { vcpuHour = 0.01295, gbHour = 0.00142 }
    ec2             = { vcpuHour = 0.048, gbHour = 0 }
    codebuildMinute = 0.01
    minBillSeconds  = 60
  })
  job_queues = merge(
    { economy = aws_batch_job_queue.economy.arn, standard = aws_batch_job_queue.standard.arn },
    var.enable_heavy_class ? { heavy = aws_batch_job_queue.heavy[0].arn } : {},
  )
  manifest_url = "https://${aws_api_gateway_rest_api.manifest.id}.execute-api.${var.aws_region}.amazonaws.com/v1"
}

module "network" {
  source = "../../modules/network"

  name   = "${var.name}-runs"
  region = var.aws_region
  # One zone halves the interface endpoints' hourly cost. If that zone has
  # an outage, runs wait until it recovers.
  az_count             = 1
  account_id           = local.account_id
  data_lake_bucket_arn = module.data_lake_bucket.bucket_arn
  project              = var.name
  environment          = "dev"
}

# --- Job execution role and logs -----------------------------------------------

resource "aws_cloudwatch_log_group" "runs" {
  name              = "/aws/batch/${var.name}-runs"
  retention_in_days = 30

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Used by Batch/ECS to pull the image and ship logs. It is never given to
# the job itself (job definitions have no jobRoleArn).
resource "aws_iam_role" "batch_execution" {
  name = "${var.name}-batch-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_iam_role_policy" "batch_execution" {
  name = "${var.name}-batch-execution"
  role = aws_iam_role.batch_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.scripts.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.runs.arn}:*"
      },
    ]
  })
}

# --- Compute ----------------------------------------------------------------------

resource "aws_batch_compute_environment" "fargate_spot" {
  name = "${var.name}-fargate-spot"
  type = "MANAGED"

  compute_resources {
    type               = "FARGATE_SPOT"
    max_vcpus          = 64
    subnets            = module.network.private_subnet_ids
    security_group_ids = [module.network.job_security_group_id]
  }

  # Owned by the network-controller Lambda (network.tf) after creation.
  state = "DISABLED"

  lifecycle {
    ignore_changes = [state]
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_batch_compute_environment" "fargate" {
  name = "${var.name}-fargate"
  type = "MANAGED"

  compute_resources {
    type               = "FARGATE"
    max_vcpus          = 64
    subnets            = module.network.private_subnet_ids
    security_group_ids = [module.network.job_security_group_id]
  }

  # Owned by the network-controller Lambda (network.tf) after creation.
  state = "DISABLED"

  lifecycle {
    ignore_changes = [state]
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Economy tries Spot first and overflows to on-demand.
resource "aws_batch_job_queue" "economy" {
  name     = "${var.name}-economy"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.fargate_spot.arn
  }

  compute_environment_order {
    order               = 2
    compute_environment = aws_batch_compute_environment.fargate.arn
  }
}

resource "aws_batch_job_queue" "standard" {
  name     = "${var.name}-standard"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.fargate.arn
  }
}

# --- Heavy (EC2), behind var.enable_heavy_class -------------------------------------------

resource "aws_iam_role" "batch_instance" {
  count = var.enable_heavy_class ? 1 : 0
  name  = "${var.name}-batch-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "batch_instance" {
  count      = var.enable_heavy_class ? 1 : 0
  role       = aws_iam_role.batch_instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "batch_instance" {
  count = var.enable_heavy_class ? 1 : 0
  name  = "${var.name}-batch-instance"
  role  = aws_iam_role.batch_instance[0].name
}

# IMDSv2 with a hop limit of 1: the ECS agent on the host can use the
# instance role, but containers (one network hop further) can't reach it.
resource "aws_launch_template" "heavy" {
  count = var.enable_heavy_class ? 1 : 0
  name  = "${var.name}-batch-heavy"

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
}

# Heavy job sizes fill these instance types, so each job gets an instance
# to itself and users never share a kernel.
resource "aws_batch_compute_environment" "heavy" {
  count = var.enable_heavy_class ? 1 : 0
  name  = "${var.name}-heavy"
  type  = "MANAGED"

  compute_resources {
    type                = "EC2"
    allocation_strategy = "BEST_FIT_PROGRESSIVE"
    instance_type       = ["m6i.2xlarge", "m6i.4xlarge", "m6i.8xlarge", "m6i.16xlarge"]
    min_vcpus           = 0
    max_vcpus           = 128
    instance_role       = aws_iam_instance_profile.batch_instance[0].arn
    subnets             = module.network.private_subnet_ids
    security_group_ids  = [module.network.job_security_group_id]

    launch_template {
      launch_template_id = aws_launch_template.heavy[0].id
      version            = "$Latest"
    }

    ec2_configuration {
      image_type = "ECS_AL2023"
    }
  }

  # Owned by the network-controller Lambda (network.tf) after creation.
  state = "DISABLED"

  lifecycle {
    ignore_changes = [state]
  }
}

resource "aws_batch_job_queue" "heavy" {
  count    = var.enable_heavy_class ? 1 : 0
  name     = "${var.name}-heavy"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.heavy[0].arn
  }
}

# --- Private manifest API ---------------------------------------------------------------

resource "aws_api_gateway_rest_api" "manifest" {
  name        = "${var.name}-run-manifest"
  description = "Private API used by run jobs to fetch inputs and register outputs"

  # No endpoint association: the execute-api endpoint is created and deleted
  # on demand (network.tf), and with private DNS on it the API is invoked at
  # its usual hostname.
  endpoint_configuration {
    types = ["PRIVATE"]
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Only requests that arrive from our VPC (through its execute-api endpoint)
# are accepted. aws:SourceVpc rather than aws:SourceVpce, because the
# endpoint's id changes each time the network-controller recreates it.
#
# The document is a local so the deployment trigger below can hash it: the
# resource's own `policy` attribute comes back from AWS normalized, which
# changed the hash mid-apply ("Provider produced inconsistent final plan").
locals {
  manifest_api_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "execute-api:Invoke"
      Resource  = "${aws_api_gateway_rest_api.manifest.execution_arn}/*"
      Condition = { StringEquals = { "aws:SourceVpc" = module.network.vpc_id } }
    }]
  })
}

resource "aws_api_gateway_rest_api_policy" "manifest" {
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  policy      = local.manifest_api_policy
}

# And the execute-api endpoint only reaches this API, so a job can't call
# other private APIs (in any account) through it. Applied by the
# network-controller when it creates the endpoint.
locals {
  execute_api_endpoint_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "execute-api:Invoke"
      Resource  = "${aws_api_gateway_rest_api.manifest.execution_arn}/*"
    }]
  })
}

resource "aws_api_gateway_resource" "manifest" {
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  parent_id   = aws_api_gateway_rest_api.manifest.root_resource_id
  path_part   = "manifest"
}

resource "aws_api_gateway_resource" "manifest_outputs" {
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  parent_id   = aws_api_gateway_rest_api.manifest.root_resource_id
  path_part   = "outputs"
}

resource "aws_api_gateway_resource" "manifest_outputs_action" {
  for_each    = toset(["presign", "complete"])
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  parent_id   = aws_api_gateway_resource.manifest_outputs.id
  path_part   = each.value
}

# Notebook sessions (sessions.tf): /session/manifest and /session/home.
resource "aws_api_gateway_resource" "manifest_session" {
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  parent_id   = aws_api_gateway_rest_api.manifest.root_resource_id
  path_part   = "session"
}

resource "aws_api_gateway_resource" "manifest_session_action" {
  for_each    = toset(["manifest", "home"])
  rest_api_id = aws_api_gateway_rest_api.manifest.id
  parent_id   = aws_api_gateway_resource.manifest_session.id
  path_part   = each.value
}

locals {
  manifest_resources = {
    manifest         = aws_api_gateway_resource.manifest.id
    presign          = aws_api_gateway_resource.manifest_outputs_action["presign"].id
    complete         = aws_api_gateway_resource.manifest_outputs_action["complete"].id
    session-manifest = aws_api_gateway_resource.manifest_session_action["manifest"].id
    session-home     = aws_api_gateway_resource.manifest_session_action["home"].id
  }
}

# No authorizer: the Lambda checks the per-run token itself.
resource "aws_api_gateway_method" "manifest" {
  for_each      = local.manifest_resources
  rest_api_id   = aws_api_gateway_rest_api.manifest.id
  resource_id   = each.value
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "manifest" {
  for_each                = local.manifest_resources
  rest_api_id             = aws_api_gateway_rest_api.manifest.id
  resource_id             = each.value
  http_method             = aws_api_gateway_method.manifest[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.runs_manifest_fn.invoke_arn
}

resource "aws_lambda_permission" "manifest" {
  statement_id  = "AllowPrivateAPI-manifest"
  action        = "lambda:InvokeFunction"
  function_name = module.runs_manifest_fn.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.manifest.execution_arn}/*/POST/*"
}

resource "aws_api_gateway_deployment" "manifest" {
  rest_api_id = aws_api_gateway_rest_api.manifest.id

  triggers = {
    redeployment = sha1(jsonencode([
      [for i in aws_api_gateway_integration.manifest : i.id],
      local.manifest_api_policy,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_rest_api_policy.manifest]
}

resource "aws_api_gateway_stage" "manifest" {
  rest_api_id   = aws_api_gateway_rest_api.manifest.id
  deployment_id = aws_api_gateway_deployment.manifest.id
  stage_name    = "v1"
}

# --- Lambdas ----------------------------------------------------------------------------

module "runs_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-runs-api"
  source_dir    = "../../../services/lambdas/runs-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 1024
  timeout       = 60
  layers        = [aws_lambda_layer_version.shared.arn]

  environment_variables = {
    METADATA_TABLE_NAME   = module.metadata_table.table_name
    QUEUES                = jsonencode(local.job_queues)
    MANIFEST_URL          = local.manifest_url
    PRICING               = local.pricing
    RUN_LOG_GROUP         = aws_cloudwatch_log_group.runs.name
    DEFAULT_MONTHLY_LIMIT = var.default_monthly_limit
    HEAVY_ENABLED         = tostring(var.enable_heavy_class)
    MAX_INPUTS            = "2000"
    # Woken right after a submit, so the network starts coming up at once.
    NETWORK_CONTROLLER_FUNCTION = module.network_controller_fn.function_name
  }

  project     = var.name
  environment = "dev"
}

module "runs_manifest_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-runs-manifest"
  source_dir    = "../../../services/lambdas/runs-manifest"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 512

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    DATA_LAKE_BUCKET    = module.data_lake_bucket.bucket_name
    URL_EXPIRES_SEC     = "3600"
    MAX_FILES_PER_UNIT  = "1000"
    MAX_BYTES_PER_UNIT  = tostring(20 * 1024 * 1024 * 1024)
    MAX_BYTES_PER_FILE  = tostring(5 * 1024 * 1024 * 1024)
    MAX_HOME_BYTES      = tostring(2 * 1024 * 1024 * 1024)
  }

  project     = var.name
  environment = "dev"
}

module "runs_events_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-runs-events"
  source_dir    = "../../../services/lambdas/runs-events"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 256

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
  }

  project     = var.name
  environment = "dev"
}

# A workspace run's rows are written with TransactWriteItems, authorized by
# the actions inside it: Puts, and the ConditionChecks that re-check the
# workspace and the caller's membership (dynamodb:ConditionCheckItem).
resource "aws_iam_policy" "runs_api" {
  name = "${var.name}-lambda-runs-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem",
        ]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect = "Allow"
        Action = "batch:SubmitJob"
        Resource = concat(
          values(local.job_queues),
          ["arn:aws:batch:${var.aws_region}:${local.account_id}:job-definition/${var.name}-mod-*"],
        )
      },
      {
        Effect   = "Allow"
        Action   = "batch:TerminateJob"
        Resource = "arn:aws:batch:${var.aws_region}:${local.account_id}:job/*"
      },
      {
        # Tags go on at submit time (userId, runId, and workspaceId for a
        # workspace run) for cost allocation.
        # With tags, SubmitJob checks TagResource on every resource in the
        # request: the job, its job definition and its job queue.
        Effect = "Allow"
        Action = "batch:TagResource"
        Resource = concat(
          [
            "arn:aws:batch:${var.aws_region}:${local.account_id}:job/*",
            "arn:aws:batch:${var.aws_region}:${local.account_id}:job-definition/${var.name}-mod-*",
          ],
          values(local.job_queues),
        )
      },
      {
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "${aws_cloudwatch_log_group.runs.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.network_controller_fn.function_arn
      },
    ]
  })
}

resource "aws_iam_policy" "runs_manifest" {
  name = "${var.name}-lambda-runs-manifest"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = module.metadata_table.table_arn
      },
      {
        # Presigned input downloads (and output checks) for artifacts,
        # including migrated firmware under devices/.
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          local.artifact_objects_arn,
          "${module.data_lake_bucket.bucket_arn}/devices/*/firmware/*",
        ]
      },
      {
        # Presigned output uploads, and the committed tag once verified.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectTagging"]
        Resource = local.artifact_objects_arn
      },
      {
        # Notebook sessions' saved notebooks folders (restore and save).
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${module.data_lake_bucket.bucket_arn}/sessions/home/*"
      },
    ]
  })
}

resource "aws_iam_policy" "runs_events" {
  name = "${var.name}-lambda-runs-events"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
      Resource = module.metadata_table.table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "runs_api" {
  role       = module.runs_api_fn.role_name
  policy_arn = aws_iam_policy.runs_api.arn
}

resource "aws_iam_role_policy_attachment" "runs_manifest" {
  role       = module.runs_manifest_fn.role_name
  policy_arn = aws_iam_policy.runs_manifest.arn
}

resource "aws_iam_role_policy_attachment" "runs_events" {
  role       = module.runs_events_fn.role_name
  policy_arn = aws_iam_policy.runs_events.arn
}

# --- Job events ------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "jobs" {
  name        = "${var.name}-run-jobs"
  description = "Run job state changes"
  event_pattern = jsonencode({
    source        = ["aws.batch"]
    "detail-type" = ["Batch Job State Change"]
    detail        = { jobQueue = values(local.job_queues) }
  })
}

resource "aws_cloudwatch_event_target" "runs_events" {
  rule = aws_cloudwatch_event_rule.jobs.name
  arn  = module.runs_events_fn.function_arn
}

resource "aws_lambda_permission" "runs_events" {
  statement_id  = "AllowEventBridge-jobs"
  action        = "lambda:InvokeFunction"
  function_name = module.runs_events_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.jobs.arn
}

# --- Routes -----------------------------------------------------------------------------

resource "aws_api_gateway_resource" "runs" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "runs"
}

resource "aws_api_gateway_resource" "runs_estimate" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs.id
  path_part   = "estimate"
}

resource "aws_api_gateway_resource" "runs_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs.id
  path_part   = "{runId}"
}

resource "aws_api_gateway_resource" "runs_id_cancel" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs_id.id
  path_part   = "cancel"
}

resource "aws_api_gateway_resource" "runs_id_children" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs_id.id
  path_part   = "children"
}

resource "aws_api_gateway_resource" "runs_id_children_index" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs_id_children.id
  path_part   = "{index}"
}

resource "aws_api_gateway_resource" "runs_id_children_index_log" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.runs_id_children_index.id
  path_part   = "log"
}

locals {
  runs_routes = {
    "runs-GET"           = { res = "runs", resource_id = aws_api_gateway_resource.runs.id, method = "GET", path = "runs" }
    "runs-POST"          = { res = "runs", resource_id = aws_api_gateway_resource.runs.id, method = "POST", path = "runs" }
    "runs-estimate-POST" = { res = "runs-estimate", resource_id = aws_api_gateway_resource.runs_estimate.id, method = "POST", path = "runs/estimate" }
    "runs-id-GET"        = { res = "runs-id", resource_id = aws_api_gateway_resource.runs_id.id, method = "GET", path = "runs/*" }
    "runs-cancel-POST"   = { res = "runs-cancel", resource_id = aws_api_gateway_resource.runs_id_cancel.id, method = "POST", path = "runs/*/cancel" }
    "runs-child-log-GET" = { res = "runs-child-log", resource_id = aws_api_gateway_resource.runs_id_children_index_log.id, method = "GET", path = "runs/*/children/*/log" }
  }

  runs_preflights = {
    for res in distinct([for r in values(local.runs_routes) : r.res]) : res => {
      resource_id = [for r in values(local.runs_routes) : r.resource_id if r.res == res][0]
      methods     = [for r in values(local.runs_routes) : r.method if r.res == res]
    }
  }
}

module "runs_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.runs_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.runs_api_fn.invoke_arn
  lambda_function_name = module.runs_api_fn.function_name
  statement_suffix     = each.key
}

module "runs_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.runs_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  runs_integration_ids = concat(
    [for r in module.runs_route : r.integration_id],
    [for p in module.runs_preflight : p.integration_id],
  )
}
