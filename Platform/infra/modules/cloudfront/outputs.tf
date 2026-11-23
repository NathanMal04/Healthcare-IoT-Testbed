output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.this.arn
}

output "distribution_hosted_zone_id" {
  description = "Route 53 zone ID for alias records that point at the distribution."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}
