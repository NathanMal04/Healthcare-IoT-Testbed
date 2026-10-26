# Private network for run jobs and notebook sessions.
#
# There is no NAT and no route to the internet: jobs reach only the S3
# gateway endpoint below and the interface endpoints (ecr.api, ecr.dkr, logs,
# execute-api, and ecs* for Heavy). Those cost about $7.30 a month each, so
# they aren't created here: the network-controller Lambda creates them while
# runs or sessions need them and deletes them after an idle period. Every
# endpoint gets a policy that only allows principals from this account (or,
# for execute-api, only our manifest API), so a job can't use AWS keys of its
# own to send data out through them.
#
# The internet gateway exists only because CloudFront VPC origins require
# one in the VPC; no route table uses it.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  tags = {
    Project = var.project
    Env     = var.environment
  }
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
        # Output uploads carry the upload-state=pending tag, which S3 also
        # checks as s3:PutObjectTagging.
        Action    = ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging"]
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

# --- Notebook sessions ---------------------------------------------------------------------

# Required by CloudFront VPC origins ("denotes that the VPC can receive
# traffic from the internet"). Nothing routes to it: the private route table
# has only the local and S3 routes, so jobs and sessions still can't reach
# the internet.
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = var.name })
}

# An ALB needs subnets in two zones. Only the load balancer's own interfaces
# (and CloudFront's VPC origin interface) live here; sessions, jobs and the
# interface endpoints stay in the private subnet(s) above, so this costs
# nothing extra. Same route table: no internet route.
locals {
  alb_azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_subnet" "alb" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.alb_azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, 240 + count.index)
  tags              = merge(local.tags, { Name = "${var.name}-alb-${local.alb_azs[count.index]}" })
}

resource "aws_route_table_association" "alb" {
  count          = 2
  subnet_id      = aws_subnet.alb[count.index].id
  route_table_id = aws_route_table.private.id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# The session load balancer: HTTP from CloudFront only, and onward only to
# session tasks.
resource "aws_security_group" "alb" {
  name        = "${var.name}-sessions-alb"
  description = "Notebook load balancer: HTTP from CloudFront, to session tasks"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
}

resource "aws_vpc_security_group_egress_rule" "alb_sessions" {
  security_group_id            = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.session_port
  to_port                      = var.session_port
  referenced_security_group_id = aws_security_group.session.id
}

# Session tasks: JupyterLab reachable only from the load balancer; outbound
# like run jobs (HTTPS to the endpoints and S3 only).
resource "aws_security_group" "session" {
  name        = "${var.name}-session"
  description = "Notebook sessions: JupyterLab from the ALB; HTTPS to VPC endpoints and S3 only"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "session_alb" {
  security_group_id            = aws_security_group.session.id
  ip_protocol                  = "tcp"
  from_port                    = var.session_port
  to_port                      = var.session_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "session_endpoints" {
  security_group_id = aws_security_group.session.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.cidr_block
}

resource "aws_vpc_security_group_egress_rule" "session_s3" {
  security_group_id = aws_security_group.session.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}
