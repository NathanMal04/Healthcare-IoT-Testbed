# Certificate for the CloudFront distribution (CloudFront only uses
# certificates from us-east-1). It is validated through DNS: by dns.tf when
# route53_zone_id is set, otherwise by hand with the records in the
# acm_validation_records output.
resource "aws_acm_certificate" "frontend" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = [for host in local.site_hosts : host if host != var.domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # With Route 53 the distribution waits for validation (dns.tf); without it
  # the certificate must already be issued before the distribution can use it
  # (Platform/scripts/deploy.sh infra waits for that).
  frontend_certificate_arn = var.route53_zone_id != "" ? aws_acm_certificate_validation.frontend[0].certificate_arn : aws_acm_certificate.frontend.arn
}
