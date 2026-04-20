resource "aws_acm_certificate" "frontend" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = var.domain_aliases
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

}