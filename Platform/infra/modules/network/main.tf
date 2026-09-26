# Private network for run jobs (and, in step 3, notebook sessions).
#
# There is no internet gateway or NAT: jobs reach only the VPC endpoints
# below. Every endpoint has a policy that only allows principals from this
# account (or, for execute-api, only our manifest API, set by the caller
# with aws_vpc_endpoint_policy), so a job can't use AWS keys of its own to
# send data out through them.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  tags = {
    Project = var.project
    Env     = var.environment
  }
  interface_endpoints = concat(
    ["ecr.api", "ecr.dkr", "logs", "execute-api"],
    var.enable_ecs_endpoints ? ["ecs", "ecs-agent", "ecs-telemetry"] : [],
  )
  account_only_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "*"
      Resource  = "*"
      Condition = { StringEquals = { "aws:PrincipalAccount" = var.account_id } }
    }]
  })
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = var.name })
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index)
  tags              = merge(local.tags, { Name = "${var.name}-private-${local.azs[count.index]}" })
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-private" })
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Jobs: no inbound; outbound HTTPS only to the interface endpoints and S3.
resource "aws_security_group" "job" {
  name        = "${var.name}-batch-job"
  description = "Run jobs: HTTPS to VPC endpoints and S3 only"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}

resource "aws_vpc_security_group_egress_rule" "job_endpoints" {
  security_group_id = aws_security_group.job.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.cidr_block
}

resource "aws_vpc_security_group_egress_rule" "job_s3" {
  security_group_id = aws_security_group.job.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface endpoints: HTTPS from inside the VPC"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "endpoints" {
  security_group_id = aws_security_group.endpoints.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.cidr_block
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = merge(local.tags, { Name = "${var.name}-s3" })

  # The data lake, through URLs presigned by this account's roles, and ECR's
  # layer bucket, which image pulls read from.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DataLake"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:PutObject"]
        Resource  = "${var.data_lake_bucket_arn}/*"
        Condition = { StringEquals = { "aws:PrincipalAccount" = var.account_id } }
      },
      {
        Sid       = "EcrLayers"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*"
      },
    ]
  })
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(local.interface_endpoints)
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${var.name}-${each.value}" })
}

# execute-api's policy is set by the caller (runs.tf), since it names the
# private API, which needs this endpoint to exist first.
resource "aws_vpc_endpoint_policy" "account_only" {
  for_each        = { for k, v in aws_vpc_endpoint.interface : k => v if k != "execute-api" }
  vpc_endpoint_id = each.value.id
  policy          = local.account_only_policy
}
