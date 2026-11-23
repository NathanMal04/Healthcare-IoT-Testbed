# Permissions of the GitHub deploy role.
#
# policies/*.json.tftpl are the original deployment's three console-managed
# policies, copied verbatim with its names replaced by ${name}, ${region} and
# ${state_bucket}. Keep them identical to the originals:
# Platform/scripts/check_deploy_policy_drift.sh compares them. A permission a
# new deploy needs goes into the template (and the original's console policy),
# not into a separate policy here, unless only some deployments need it (as
# with Route 53 below).

locals {
  policy_vars = {
    name         = var.name
    region       = var.aws_region
    state_bucket = var.state_bucket_name
  }

  deploy_policies = local.github ? {
    core     = "Terraform state, web/data lake buckets, CloudFront, ACM, Cognito, DynamoDB, Lambda, API Gateway, IAM, Logs"
    runs     = "Run network, ECR, CodeBuild, Batch, EventBridge, platform environment seeding"
    sessions = "Notebook sessions: load balancer, ECS cluster, CloudFront VPC origin"
  } : {}
}

resource "aws_iam_policy" "deploy" {
  for_each    = local.deploy_policies
  name        = "${var.name}-deploy-${each.key}"
  description = each.value
  # Re-encoded to drop the template's whitespace (managed policies are
  # limited to 6144 characters).
  policy = jsonencode(jsondecode(templatefile("${path.module}/policies/deploy-${each.key}.json.tftpl", local.policy_vars)))
  tags   = local.deploy_tag
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each   = aws_iam_policy.deploy
  role       = aws_iam_role.github_deploy[0].name
  policy_arn = each.value.arn
}

# DNS records for envs/dev/dns.tf: certificate validation and the site's
# alias records, in the one hosted zone.
resource "aws_iam_policy" "deploy_dns" {
  count       = local.github && var.route53_zone_id != "" ? 1 : 0
  name        = "${var.name}-deploy-dns"
  description = "Route 53 records in the site's hosted zone"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SiteZoneRecords"
        Effect   = "Allow"
        Action   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets", "route53:ListTagsForResource"]
        Resource = "arn:aws:route53:::hostedzone/${var.route53_zone_id}"
      },
      {
        Sid      = "ChangeStatus"
        Effect   = "Allow"
        Action   = "route53:GetChange"
        Resource = "arn:aws:route53:::change/*"
      },
    ]
  })
  tags = local.deploy_tag
}

resource "aws_iam_role_policy_attachment" "deploy_dns" {
  count      = length(aws_iam_policy.deploy_dns)
  role       = aws_iam_role.github_deploy[0].name
  policy_arn = aws_iam_policy.deploy_dns[0].arn
}
