resource "aws_cloudfront_origin_access_control" "this" {
  name                              = "${var.project}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Serves two viewer-request concerns in one function, in order:
#
# 1. Redirects any non-canonical hostname (www, the *.cloudfront.net default
#    domain) to canonical_host with a 301. The API Gateway, Lambda and S3 CORS
#    layers each pin a single allowed origin, so an app served on a second
#    hostname loads but has every API and upload call blocked by the browser.
#    Collapsing to one origin here keeps that invariant in one place instead of
#    duplicating an origin allowlist across all three layers.
# 2. Rewrites extensionless URIs to their static-export equivalents so paths
#    like /login resolve to /login.html (and /login/ resolves to
#    /login/index.html if trailingSlash is ever enabled in next.config).
resource "aws_cloudfront_function" "url_rewrite" {
  name    = "${var.project}-url-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    var CANONICAL_HOST = '${var.canonical_host}';

    function handler(event) {
      var request = event.request;

      if (CANONICAL_HOST !== '' && request.headers.host.value.toLowerCase() !== CANONICAL_HOST) {
        return {
          statusCode: 301,
          statusDescription: 'Moved Permanently',
          headers: {
            'location': {
              value: 'https://' + CANONICAL_HOST + request.uri + buildQueryString(request.querystring)
            },
            'cache-control': { value: 'max-age=3600' }
          }
        };
      }

      var uri = request.uri;
      if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
      } else if (!uri.includes('.')) {
        request.uri = uri + '.html';
      }
      return request;
    }

    // Preserves the query string across the redirect. CloudFront hands it over
    // as an object keyed by parameter name, already URL-encoded, with repeated
    // parameters under multiValue.
    function buildQueryString(querystring) {
      var params = [];
      for (var name in querystring) {
        var param = querystring[name];
        if (param.multiValue) {
          for (var i = 0; i < param.multiValue.length; i++) {
            params.push(name + '=' + param.multiValue[i].value);
          }
        } else if (param.value === '') {
          params.push(name);
        } else {
          params.push(name + '=' + param.value);
        }
      }
      return params.length > 0 ? '?' + params.join('&') : '';
    }
  EOT
}

resource "aws_cloudfront_distribution" "this" {
  aliases = var.aliases
  origin {
    domain_name              = var.s3_bucket_regional_domain_name
    origin_id                = var.s3_bucket_name
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  enabled             = true
  default_root_object = var.default_root_object

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = var.s3_bucket_name
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.url_rewrite.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
  acm_certificate_arn      = var.acm_certificate_arn
  ssl_support_method       = "sni-only"
  minimum_protocol_version = "TLSv1.2_2021"
}

  tags = {
    Project = var.project
    Env     = var.environment
  }
}

resource "aws_s3_bucket_policy" "cloudfront_access" {
  bucket = var.s3_bucket_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipal"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${var.s3_bucket_arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.this.arn
          }
        }
      }
    ]
  })
}
