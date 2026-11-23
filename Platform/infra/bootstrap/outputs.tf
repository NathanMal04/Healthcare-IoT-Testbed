output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "GitHub repository secret AWS_ROLE_ARN."
  value       = local.github ? aws_iam_role.github_deploy[0].arn : null
}

output "backend_hcl" {
  description = "Contents for envs/dev/backend.hcl."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.bucket}"
    key          = "dev/terraform.tfstate"
    region       = "${var.aws_region}"
    use_lockfile = true
  EOT
}
