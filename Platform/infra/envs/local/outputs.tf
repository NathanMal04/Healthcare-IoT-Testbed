output "web_bucket_name" {
  value = module.web_bucket.bucket_name
}

output "data_lake_bucket_name" {
  value = module.data_lake.bucket_name
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

output "api_invoke_url" {
  value = module.api.invoke_url
}

output "lambda_dynamodb_policy_arn" {
  value = aws_iam_policy.lambda_dynamodb.arn
}
