# Outputs useful values

output "web_bucket_name" {
  value = module.web_bucket.bucket_name
}

output "data_lake_bucket_name" {
  value = module.data_lake.bucket_name
}

output "data_lake_bucket_arn" {
  value = module.data_lake.bucket_arn
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

output "dynamodb_table_name" {
  value = module.database.table_name
}

output "dynamodb_table_arn" {
  value = module.database.table_arn
}

output "lambda_dynamodb_policy_arn" {
  value = aws_iam_policy.lambda_dynamodb.arn
}

output "api_invoke_url" {
  value = module.api.invoke_url
}
