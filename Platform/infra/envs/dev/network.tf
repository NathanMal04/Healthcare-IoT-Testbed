# On-demand network: the VPC's interface endpoints (ecr.api, ecr.dkr, logs,
# execute-api, plus ecs* for Heavy) exist only while runs or notebook
# sessions are active, and for var.network_idle_minutes after the last one.
# Always on, they would cost about $51 a month; on demand, about $0.04 an
# hour while up ($0.07 with the Heavy ones).
#
# The network-controller Lambda creates and deletes them, and enables the
# Batch compute environments only while their endpoints are available (they
# are created DISABLED in runs.tf). It runs every minute and is woken by
# runs-api and sessions-api when work starts. The VPC, subnets, security
# groups and the (free) S3 gateway endpoint stay in modules/network.

module "network_controller_fn" {
  source        = "../../modules/lambda"
  function_name = "${var.name}-network-controller"
  source_dir    = "../../../services/lambdas/network-controller"
  handler       = "lambda_function.handler"
  runtime       = "python3.12"
  timeout       = 60

  environment_variables = {
    METADATA_TABLE_NAME = module.metadata_table.table_name
    VPC_ID              = module.network.vpc_id
    SUBNET_IDS          = jsonencode(module.network.private_subnet_ids)
    ENDPOINT_SG_ID      = module.network.endpoint_security_group_id
    IDLE_MINUTES        = tostring(var.network_idle_minutes)
    ACCOUNT_POLICY      = module.network.account_only_endpoint_policy
    EXECUTE_API_POLICY  = local.execute_api_endpoint_policy
    COMPUTE_ENVS = jsonencode(merge(
      {
        fargate     = aws_batch_compute_environment.fargate.arn
        fargateSpot = aws_batch_compute_environment.fargate_spot.arn
      },
      var.enable_heavy_class ? { heavy = aws_batch_compute_environment.heavy[0].arn } : {},
    ))
    HEAVY_ENABLED         = tostring(var.enable_heavy_class)
    SESSIONS_API_FUNCTION = "${var.name}-sessions-api"
  }

  project     = var.name
  environment = "dev"
}

locals {
  endpoint_arn_pattern = "arn:aws:ec2:${var.aws_region}:${local.account_id}:vpc-endpoint/*"
}

resource "aws_iam_policy" "network_controller" {
  name = "${var.name}-lambda-network-controller"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Only in this VPC, subnet and endpoint security group; the new
        # endpoint must carry the controller's tag.
        Effect = "Allow"
        Action = "ec2:CreateVpcEndpoint"
        Resource = concat(
          [module.network.vpc_arn, module.network.endpoint_security_group_arn],
          module.network.private_subnet_arns,
        )
      },
      {
        Effect   = "Allow"
        Action   = "ec2:CreateVpcEndpoint"
        Resource = local.endpoint_arn_pattern
        Condition = {
          StringEquals = { "aws:RequestTag/ManagedBy" = "network-controller" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:CreateTags"
        Resource = local.endpoint_arn_pattern
        Condition = {
          StringEquals = { "ec2:CreateAction" = "CreateVpcEndpoint" }
        }
      },
      {
        # Only endpoints it created.
        Effect   = "Allow"
        Action   = "ec2:DeleteVpcEndpoints"
        Resource = local.endpoint_arn_pattern
        Condition = {
          StringEquals = { "aws:ResourceTag/ManagedBy" = "network-controller" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeVpcEndpoints"
        Resource = "*"
      },
      {
        # Private DNS on an interface endpoint associates the VPC with the
        # service's AWS-managed private hosted zone.
        Effect   = "Allow"
        Action   = "route53:AssociateVPCWithHostedZone"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = "batch:UpdateComputeEnvironment"
        Resource = concat(
          [aws_batch_compute_environment.fargate.arn, aws_batch_compute_environment.fargate_spot.arn],
          aws_batch_compute_environment.heavy[*].arn,
        )
      },
      {
        Effect   = "Allow"
        Action   = "batch:DescribeComputeEnvironments"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem",
        ]
        Resource = module.metadata_table.table_arn
      },
      {
        # Launches notebook sessions that were waiting for the network.
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:${var.name}-sessions-api"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "network_controller" {
  role       = module.network_controller_fn.role_name
  policy_arn = aws_iam_policy.network_controller.arn
}

resource "aws_cloudwatch_event_rule" "network_controller" {
  name                = "${var.name}-network-controller"
  description         = "Reconciles the on-demand VPC endpoints"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "network_controller" {
  rule = aws_cloudwatch_event_rule.network_controller.name
  arn  = module.network_controller_fn.function_arn
}

resource "aws_lambda_permission" "network_controller" {
  statement_id  = "AllowEventBridge-network-controller"
  action        = "lambda:InvokeFunction"
  function_name = module.network_controller_fn.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.network_controller.arn
}
