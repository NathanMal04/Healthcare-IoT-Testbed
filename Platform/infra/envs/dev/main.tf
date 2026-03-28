# Main infrastructure definitions

module "web_bucket" {
  source = "../../modules/s3_bucket"

  bucket_name = "${var.name}-web"
  project     = var.name
  environment = "dev"
}

module "cdn" {
  source = "../../modules/cloudfront"

  s3_bucket_name                 = module.web_bucket.bucket_name
  s3_bucket_regional_domain_name = module.web_bucket.bucket_regional_domain_name
  s3_bucket_arn                  = module.web_bucket.bucket_arn
  project                        = var.name
  environment                    = "dev"
}

module "auth" {
  source = "../../modules/cognito"

  pool_name     = "${var.name}-users"
  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls
  project       = var.name
  environment   = "dev"
}

module "database" {
  source = "../../modules/dynamodb"

  table_name = "${var.name}-data"
  hash_key   = var.dynamodb_hash_key
  range_key  = var.dynamodb_range_key
  attributes = var.dynamodb_attributes
  project    = var.name
  environment = "dev"
}
