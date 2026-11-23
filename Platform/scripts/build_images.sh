#!/usr/bin/env bash
# Builds the platform images (analysis-base and platform-ghidra, which carry
# the launcher and SDK), pushes them to ECR, and records them as new ready
# versions of the platform environments. Also builds the notebook layer
# (JupyterLab, copied into notebook sessions) and records it.
# Used by deploy-images.yml and deploy.sh.
#
#   Platform/scripts/build_images.sh
#
# Needs an initialised and applied envs/dev (tf_init.sh), Docker, Python 3 with
# boto3, and AWS credentials that can push to ECR and write the metadata table.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="$ROOT/Platform/infra/envs/dev"
SEED="$ROOT/Platform/scripts/seed_platform_envs.py"

out() { terraform -chdir="$ENV_DIR" output -raw "$1"; }

# The ECR repository comes from the infrastructure deploy. If it isn't there
# yet, stop here rather than push to the wrong registry.
if ! repo="$(out platform_base_repository_url 2>/dev/null)" || [[ -z "$repo" ]]; then
  msg="platform_base_repository_url is not in the Terraform state yet. Deploy the infrastructure first, then re-run this."
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error::$msg" >&2 || echo "$msg" >&2
  exit 1
fi
table="$(out metadata_table_name)"
bucket="$(out data_lake_bucket_name)"
region="${AWS_REGION:-$(out aws_region)}"
registry="${repo%%/*}"

# Image tag suffix: the commit, marked when built from uncommitted changes.
sha="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
suffix="${sha::12}"
if [[ -z "${GITHUB_SHA:-}" ]] && [[ -n "$(git -C "$ROOT" status --porcelain -- Platform/services/containers)" ]]; then
  suffix="$suffix-dirty-$(date +%s)"
fi

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"

cd "$ROOT/Platform/services/containers"

# Builds, pushes and records one platform environment image. Prints its digest.
build_env() {
  local env_id="$1" dockerfile="$2" name="$3"; shift 3
  local tag="$repo:$name-$suffix" digest packages
  docker build -f "$dockerfile" "$@" -t "$tag" . >&2
  docker push "$tag" >&2
  digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
  packages="$(mktemp -d)"
  docker run --rm --network none --entrypoint sh "$tag" -c "python3 -m pip freeze --all" > "$packages/pip-freeze.txt"
  docker run --rm --network none --entrypoint sh "$tag" -c "dpkg-query -W -f '\${Package} \${Version}\n'" > "$packages/dpkg.txt"
  python3 "$SEED" --table "$table" --region "$region" \
    --env-id "$env_id" --image-uri "$digest" \
    --packages-dir "$packages" --bucket "$bucket" >&2
  echo "$digest"
}

base_digest="$(build_env platform-base base/Dockerfile base)"
build_env platform-ghidra ghidra/Dockerfile ghidra --build-arg BASE_IMAGE="$base_digest" > /dev/null

# The notebook layer.
tag="$repo:notebook-$suffix"
docker build -f notebook/Dockerfile -t "$tag" .
docker push "$tag"
digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
python3 "$SEED" --table "$table" --region "$region" --notebook-image-uri "$digest"
