data "archive_file" "this" {
  count       = var.package_type == "Zip" ? 1 : 0
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "/tmp/lambda-${var.function_name}.zip"
}

resource "aws_iam_role" "this" {
  name = "${var.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project = var.project
    Env     = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "basic_execution" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "durable_execution" {
  count      = var.durable ? 1 : 0
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "additional" {
  for_each   = toset(var.additional_policy_arns)
  role       = aws_iam_role.this.name
  policy_arn = each.value
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days

  tags = {
    Project = var.project
    Env     = var.environment
  }
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  package_type  = var.package_type
  role          = aws_iam_role.this.arn
  memory_size   = var.memory_size
  timeout       = var.timeout

  # Zip deployment
  filename         = var.package_type == "Zip" ? data.archive_file.this[0].output_path : null
  source_code_hash = var.package_type == "Zip" ? data.archive_file.this[0].output_base64sha256 : null
  handler          = var.package_type == "Zip" ? var.handler : null
  runtime          = var.package_type == "Zip" ? var.runtime : null

  # Container deployment
  image_uri = var.package_type == "Image" ? var.image_uri : null

  dynamic "durable_config" {
    for_each = var.durable ? [1] : []
    content {
      execution_timeout = var.durable_execution_timeout
      retention_period  = var.durable_retention_period
    }
  }

  dynamic "environment" {
    for_each = length(var.environment_variables) > 0 ? [1] : []
    content {
      variables = var.environment_variables
    }
  }

  tags = {
    Project = var.project
    Env     = var.environment
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_lambda_alias" "this" {
  count            = var.durable ? 1 : 0
  name             = var.durable_alias_name
  function_name    = aws_lambda_function.this.function_name
  function_version = aws_lambda_function.this.version
}
