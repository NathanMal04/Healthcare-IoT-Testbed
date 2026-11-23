# DNS in Route 53, when route53_zone_id is set: the certificate's validation
# records and the site's alias records. Without it, add the same records at
# your DNS provider by hand: the acm_validation_records output, and a CNAME
# (or ALIAS/ANAME at the apex) from each hostname to cloudfront_domain_name.

locals {
  route53 = var.route53_zone_id != ""
}

resource "aws_route53_record" "frontend_validation" {
  for_each = local.route53 ? {
    for option in aws_acm_certificate.frontend.domain_validation_options : option.domain_name => option
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "frontend" {
  count                   = local.route53 ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.frontend_validation : record.fqdn]
}

resource "aws_route53_record" "site" {
  for_each = local.route53 ? {
    for pair in setproduct(local.site_hosts, ["A", "AAAA"]) : "${pair[0]}/${pair[1]}" => { host = pair[0], type = pair[1] }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.host
  type    = each.value.type

  alias {
    name                   = module.cdn.distribution_domain_name
    zone_id                = module.cdn.distribution_hosted_zone_id
    evaluate_target_health = false
  }
}
