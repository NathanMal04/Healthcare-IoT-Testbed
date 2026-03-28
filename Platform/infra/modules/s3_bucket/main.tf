resource "aws_s3_bucket" "bucket" {
  bucket = var.bucket_name

  tags = {
    Project = var.project
    Env     = var.environment
  }
}