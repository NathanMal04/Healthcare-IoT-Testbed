# GitHub Actions authenticates to AWS with OIDC: the workflows exchange their
# GitHub token for this role's credentials, so no long-lived keys are stored.
# Created only when github_repo is set.

locals {
  github     = var.github_repo != null
  oidc_host  = "token.actions.githubusercontent.com"
  oidc_arn   = local.github ? (var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn) : null
  deploy_tag = { Project = var.name }
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = local.github && var.create_oidc_provider ? 1 : 0
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
  tags           = local.deploy_tag
}

data "aws_iam_openid_connect_provider" "github" {
  count = local.github && !var.create_oidc_provider ? 1 : 0
  url   = "https://${local.oidc_host}"
}

resource "aws_iam_role" "github_deploy" {
  count = local.github ? 1 : 0
  name  = "${var.name}-github-deploy"

  # Any workflow in the repository (every branch and pull request) may assume
  # it, as on the original deployment.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "${local.oidc_host}:aud" = "sts.amazonaws.com" }
        StringLike   = { "${local.oidc_host}:sub" = "repo:${var.github_repo}:*" }
      }
    }]
  })

  tags = local.deploy_tag
}
