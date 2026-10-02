# Shared Python code for the Lambdas, published as a layer. Lambda extracts
# layers under /opt and puts /opt/python on the import path, so
# services/lambdas/_shared/python/testbed_authz.py is importable as
# `testbed_authz` by every function that lists this layer.
#
# Functions using it: create-device, list-devices, update-device and the old
# presign-firmware, complete-firmware and list-firmware (main.tf), every
# artifacts-* function except artifacts-verify (artifacts.tf), and
# workspaces-api (workspaces.tf).

data "archive_file" "shared_layer" {
  type        = "zip"
  source_dir  = "../../../services/lambdas/_shared"
  output_path = "/tmp/lambda-layer-${var.name}-shared.zip"
  # Bytecode left by local test runs would change the hash and publish a
  # new layer version for no code change.
  excludes = ["**/__pycache__/**"]
}

resource "aws_lambda_layer_version" "shared" {
  layer_name          = "${var.name}-shared"
  description         = "Shared Lambda code (testbed_authz)"
  filename            = data.archive_file.shared_layer.output_path
  source_code_hash    = data.archive_file.shared_layer.output_base64sha256
  compatible_runtimes = ["python3.12"]
}
