# Outputs useful values

output "web_bucket_name" {
  value = module.web_bucket.bucket_name
}

output "data_lake_bucket_name" {
  value = module.data_lake_bucket.bucket_name
}

output "data_lake_bucket_arn" {
  value = module.data_lake_bucket.bucket_arn
}

output "cloudfront_distribution_id" {
  value = module.cdn.distribution_id
}

output "cloudfront_domain_name" {
  value = module.cdn.distribution_domain_name
}

output "cognito_user_pool_id" {
  value = module.auth.user_pool_id
}

output "cognito_user_pool_client_id" {
  value = module.auth.user_pool_client_id
}

output "metadata_table_name" {
  value = module.metadata_table.table_name
}

output "metadata_table_arn" {
  value = module.metadata_table.table_arn
}

output "users_table_name" {
  value = module.users_table.table_name
}

output "users_table_arn" {
  value = module.users_table.table_arn
}

output "lambda_dynamodb_policy_arn" {
  value = aws_iam_policy.lambda_dynamodb.arn
}

output "api_invoke_url" {
  value = module.api.invoke_url
}

output "platform_base_repository_url" {
  value = aws_ecr_repository.platform_base.repository_url
}

output "scripts_repository_url" {
  value = aws_ecr_repository.scripts.repository_url
}

output "image_build_project" {
  value = aws_codebuild_project.images.name
}

output "run_manifest_url" {
  value = local.manifest_url
}

# The site's origin, hostname and brand, for the web build (deploy-web.yml).
output "site_origin" {
  value = local.site_origin
}

output "site_host" {
  value = var.domain_name
}

output "brand_name" {
  value = local.brand_name
}

output "aws_region" {
  value = var.aws_region
}

# DNS records that validate the CloudFront certificate. With route53_zone_id
# set they are created automatically; otherwise add them at your DNS provider.
output "acm_validation_records" {
  value = [
    for option in aws_acm_certificate.frontend.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}

output "acm_certificate_arn" {
  value = aws_acm_certificate.frontend.arn
}
