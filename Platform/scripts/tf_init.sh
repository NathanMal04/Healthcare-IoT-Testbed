#!/usr/bin/env bash
# terraform init for Platform/infra/envs/dev, with the state backend from
#   - envs/dev/backend.hcl, if it exists (local use; see backend.hcl.example), or
#   - the environment (CI): TF_STATE_BUCKET (required), TF_STATE_REGION
#     (default AWS_REGION), TF_STATE_KEY (default dev/terraform.tfstate),
#     TF_USE_LOCKFILE=true for S3-native state locking.
# Extra arguments are passed to terraform init.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/envs/dev" && pwd)"

if [[ -f "$ENV_DIR/backend.hcl" && -z "${TF_STATE_BUCKET:-}" ]]; then
  exec terraform -chdir="$ENV_DIR" init -input=false -backend-config=backend.hcl "$@"
fi

if [[ -z "${TF_STATE_BUCKET:-}" ]]; then
  msg="No Terraform state backend configured: set the TF_STATE_BUCKET repository variable (CI), or create Platform/infra/envs/dev/backend.hcl (see backend.hcl.example)."
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error::$msg" >&2 || echo "$msg" >&2
  exit 1
fi

region="${TF_STATE_REGION:-${AWS_REGION:-}}"
if [[ -z "$region" ]]; then
  echo "Set TF_STATE_REGION or AWS_REGION to the state bucket's region." >&2
  exit 1
fi

args=(
  -backend-config="bucket=$TF_STATE_BUCKET"
  -backend-config="key=${TF_STATE_KEY:-dev/terraform.tfstate}"
  -backend-config="region=$region"
)
if [[ "${TF_USE_LOCKFILE:-}" == "true" ]]; then
  args+=(-backend-config="use_lockfile=true")
fi

exec terraform -chdir="$ENV_DIR" init -input=false "${args[@]}" "$@"
