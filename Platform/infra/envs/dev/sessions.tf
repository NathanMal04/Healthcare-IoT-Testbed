# Step 3: notebook sessions (JupyterLab on an environment).
#
#   GET/POST /sessions                      sessions-api
#   GET      /sessions/{sessionId}          sessions-api
#   POST     /sessions/{sessionId}/stop     sessions-api
#   GET      /sessions/{sessionId}/log      sessions-api
#
# A session is an ECS task on Fargate in the runs' private subnet (no
# internet, no IAM role; files through the manifest API). The browser reaches
# it at vzoniq.com/s/{sessionId}/: CloudFront sends /s/* through a VPC origin
# to the internal load balancer below, where sessions-api adds a target group
# and listener rule per session. The load balancer is the only always-on
# cost here (about $17/month); tasks are billed per second while open.
#
# The network is on demand (network.tf): sessions-api wakes the
# network-controller, which launches waiting sessions once it's up. ECS
# "Task State Change" events go to sessions-events (target registration,
# settlement) and usage-meter (usage.tf).

resource "aws_ecs_cluster" "sessions" {
  name = "${var.name}-sessions"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

resource "aws_cloudwatch_log_group" "sessions" {
  name              = "/aws/ecs/${var.name}-sessions"
  retention_in_days = 14

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Pulls the environment and notebook images and ships logs. Never given to
# the task itself (task definitions have no taskRoleArn).
resource "aws_iam_role" "session_execution" {
  name = "${var.name}-session-execution"

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

resource "aws_iam_role_policy" "session_execution" {
  name = "${var.name}-session-execution"
  role = aws_iam_role.session_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        # Environment images (user environments live in scripts, platform
        # ones and the notebook layer in platform-base).
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [aws_ecr_repository.scripts.arn, aws_ecr_repository.platform_base.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.sessions.arn}:*"
      },
    ]
  })
}

# --- Load balancer and CloudFront origin ------------------------------------------------

resource "aws_lb" "sessions" {
  name               = "${var.name}-nb"
  internal           = true
  load_balancer_type = "application"
  subnets            = module.network.alb_subnet_ids
  security_groups    = [module.network.alb_security_group_id]
  # Open notebooks keep WebSockets up for a long time.
  idle_timeout               = 3600
  drop_invalid_header_fields = true

  tags = {
    Project = var.name
    Env     = "dev"
  }
}

# Plain HTTP inside the VPC: CloudFront terminates TLS and reaches the load
# balancer over its private VPC origin connection.
resource "aws_lb_listener" "sessions" {
  load_balancer_arn = aws_lb.sessions.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "No such notebook session"
      status_code  = "404"
    }
  }
}

resource "aws_cloudfront_vpc_origin" "sessions" {
  vpc_origin_endpoint_config {
    name                   = "${var.name}-sessions"
    arn                    = aws_lb.sessions.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  tags = {
    Project = var.name
    Env     = "dev"
  }

  # The VPC origin needs the internet gateway attached (modules/network).
  depends_on = [module.network]
}

# --- Lambdas --------------------------------------------------------------------------------

module "sessions_api_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-sessions-api"
  source_dir    = "../../../services/lambdas/sessions-api"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 512
  timeout       = 60
  layers        = [aws_lambda_layer_version.shared.arn]

  environment_variables = {
    METADATA_TABLE_NAME         = module.metadata_table.table_name
    CLUSTER_ARN                 = aws_ecs_cluster.sessions.arn
    LISTENER_ARN                = aws_lb_listener.sessions.arn
    VPC_ID                      = module.network.vpc_id
    SUBNET_IDS                  = jsonencode(module.network.private_subnet_ids)
    SECURITY_GROUP_ID           = module.network.session_security_group_id
    EXECUTION_ROLE_ARN          = aws_iam_role.session_execution.arn
    LOG_GROUP                   = aws_cloudwatch_log_group.sessions.name
    TASKDEF_PREFIX              = var.name
    MANIFEST_URL                = local.manifest_url
    PRICING                     = local.pricing
    DEFAULT_MONTHLY_LIMIT       = var.default_monthly_limit
    NETWORK_CONTROLLER_FUNCTION = module.network_controller_fn.function_name
    MAX_HOURS                   = "8"
    MAX_ACTIVE_SESSIONS         = "2"
    IDLE_MINUTES                = "30"
  }

  project     = var.name
  environment = "dev"
}

module "sessions_events_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-sessions-events"
  source_dir    = "../../../services/lambdas/sessions-events"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  memory_size   = 256

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    CLUSTER_ARN         = aws_ecs_cluster.sessions.arn
  }

  project     = var.name
  environment = "dev"
}

locals {
  session_target_groups = "arn:aws:elasticloadbalancing:${var.aws_region}:${local.account_id}:targetgroup/nb-*/*"
  session_rules         = "arn:aws:elasticloadbalancing:${var.aws_region}:${local.account_id}:listener-rule/app/${aws_lb.sessions.name}/*"
  session_tasks         = "arn:aws:ecs:${var.aws_region}:${local.account_id}:task/${aws_ecs_cluster.sessions.name}/*"
}

resource "aws_iam_policy" "sessions_api" {
  name = "${var.name}-lambda-sessions-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = module.metadata_table.table_arn
      },
      {
        # Task definitions are registered per environment version on first use.
        Effect   = "Allow"
        Action   = "ecs:RegisterTaskDefinition"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = "arn:aws:ecs:${var.aws_region}:${local.account_id}:task-definition/${var.name}-nb-*:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.sessions.arn }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ecs:TagResource"
        Resource = local.session_tasks
        Condition = {
          StringEquals = { "ecs:CreateAction" = "RunTask" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ecs:StopTask"
        Resource = local.session_tasks
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.session_execution.arn
      },
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup"]
        Resource = local.session_target_groups
      },
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule"]
        Resource = [aws_lb_listener.sessions.arn, local.session_rules]
      },
      {
        # Describe actions don't support resource-level permissions.
        Effect   = "Allow"
        Action   = "elasticloadbalancing:DescribeTargetHealth"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "${aws_cloudwatch_log_group.sessions.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.network_controller_fn.function_arn
      },
    ]
  })
}

resource "aws_iam_policy" "sessions_events" {
  name = "${var.name}-lambda-sessions-events"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = module.metadata_table.table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeleteTargetGroup"]
        Resource = local.session_target_groups
      },
      {
        Effect   = "Allow"
        Action   = "elasticloadbalancing:DeleteRule"
        Resource = local.session_rules
      },
      {
        Effect   = "Allow"
        Action   = "ecs:StopTask"
        Resource = local.session_tasks
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sessions_api" {
  role       = module.sessions_api_fn.role_name
  policy_arn = aws_iam_policy.sessions_api.arn
}

resource "aws_iam_role_policy_attachment" "sessions_events" {
  role       = module.sessions_events_fn.role_name
  policy_arn = aws_iam_policy.sessions_events.arn
}

# --- Task events ----------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "sessions" {
  name        = "${var.name}-session-tasks"
  description = "Notebook session task state changes"
  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail        = { clusterArn = [aws_ecs_cluster.sessions.arn] }
  })
}

resource "aws_cloudwatch_event_target" "sessions_events" {
  rule = aws_cloudwatch_event_rule.sessions.name
  arn  = module.sessions_events_fn.function_arn
}

resource "aws_lambda_permission" "sessions_events" {
  statement_id  = "AllowEventBridge-session-tasks"
  action        = "lambda:InvokeFunction"
  function_name = module.sessions_events_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sessions.arn
}

resource "aws_cloudwatch_event_target" "usage_sessions" {
  rule = aws_cloudwatch_event_rule.sessions.name
  arn  = module.usage_meter_fn.function_arn
}

resource "aws_lambda_permission" "usage_sessions" {
  statement_id  = "AllowEventBridge-session-tasks"
  action        = "lambda:InvokeFunction"
  function_name = module.usage_meter_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sessions.arn
}

# --- Routes ---------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "sessions" {
  rest_api_id = module.api.rest_api_id
  parent_id   = module.api.root_resource_id
  path_part   = "sessions"
}

resource "aws_api_gateway_resource" "sessions_id" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.sessions.id
  path_part   = "{sessionId}"
}

resource "aws_api_gateway_resource" "sessions_id_action" {
  for_each    = toset(["stop", "log"])
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.sessions_id.id
  path_part   = each.value
}

locals {
  sessions_routes = {
    "sessions-GET"       = { res = "sessions", resource_id = aws_api_gateway_resource.sessions.id, method = "GET", path = "sessions" }
    "sessions-POST"      = { res = "sessions", resource_id = aws_api_gateway_resource.sessions.id, method = "POST", path = "sessions" }
    "sessions-id-GET"    = { res = "sessions-id", resource_id = aws_api_gateway_resource.sessions_id.id, method = "GET", path = "sessions/*" }
    "sessions-stop-POST" = { res = "sessions-stop", resource_id = aws_api_gateway_resource.sessions_id_action["stop"].id, method = "POST", path = "sessions/*/stop" }
    "sessions-log-GET"   = { res = "sessions-log", resource_id = aws_api_gateway_resource.sessions_id_action["log"].id, method = "GET", path = "sessions/*/log" }
  }

  sessions_preflights = {
    for res in distinct([for r in values(local.sessions_routes) : r.res]) : res => {
      resource_id = [for r in values(local.sessions_routes) : r.resource_id if r.res == res][0]
      methods     = [for r in values(local.sessions_routes) : r.method if r.res == res]
    }
  }
}

module "sessions_route" {
  source   = "../../modules/api_lambda_method"
  for_each = local.sessions_routes

  rest_api_id          = module.api.rest_api_id
  resource_id          = each.value.resource_id
  execution_arn        = module.api.execution_arn
  http_method          = each.value.method
  route_path           = each.value.path
  authorizer_id        = module.api.cognito_authorizer_id
  lambda_invoke_arn    = module.sessions_api_fn.invoke_arn
  lambda_function_name = module.sessions_api_fn.function_name
  statement_suffix     = each.key
}

module "sessions_preflight" {
  source   = "../../modules/api_cors_preflight"
  for_each = local.sessions_preflights

  rest_api_id     = module.api.rest_api_id
  resource_id     = each.value.resource_id
  allowed_methods = each.value.methods
}

locals {
  sessions_integration_ids = concat(
    [for r in module.sessions_route : r.integration_id],
    [for p in module.sessions_preflight : p.integration_id],
  )
}
