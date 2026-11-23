#!/usr/bin/env bash
# Builds the web app with the deployed environment's settings and publishes it.
# Used by deploy-web.yml, frontend-pr-check.yml (--build-only) and deploy.sh.
#
#   Platform/scripts/deploy_web.sh [--build-only]
#
# Needs an initialised envs/dev (tf_init.sh), Node.js and, to publish, AWS
# credentials that can write the web bucket and invalidate the distribution.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="$ROOT/Platform/infra/envs/dev"
WEB_DIR="$ROOT/Platform/services/web"

build_only=false
[[ "${1:-}" == "--build-only" ]] && build_only=true

out() { terraform -chdir="$ENV_DIR" output -raw "$1"; }
# Outputs a state may not have yet (added after it was last applied); the app
# falls back to its defaults (lib/brand.ts).
optional_out() { terraform -chdir="$ENV_DIR" output -raw "$1" 2>/dev/null || true; }

NEXT_PUBLIC_COGNITO_USER_POOL_ID="$(out cognito_user_pool_id)"
NEXT_PUBLIC_COGNITO_CLIENT_ID="$(out cognito_user_pool_client_id)"
NEXT_PUBLIC_API_URL="$(out api_invoke_url)"
NEXT_PUBLIC_BRAND_NAME="$(optional_out brand_name)"
NEXT_PUBLIC_SITE_HOST="$(optional_out site_host)"
export NEXT_PUBLIC_COGNITO_USER_POOL_ID NEXT_PUBLIC_COGNITO_CLIENT_ID NEXT_PUBLIC_API_URL NEXT_PUBLIC_BRAND_NAME NEXT_PUBLIC_SITE_HOST

cd "$WEB_DIR"
npm ci
npm run build

if $build_only; then
  exit 0
fi

bucket="$(out web_bucket_name)"
distribution="$(out cloudfront_distribution_id)"

aws s3 sync out/ "s3://$bucket" \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "*.html" \
  --exclude "*.txt"
# Pages and their *.txt RSC payloads (fetched on client-side navigation) keep
# the same names across builds, so they must never be cached as immutable.
aws s3 sync out/ "s3://$bucket" \
  --delete \
  --cache-control "no-cache" \
  --include "*.html" \
  --include "*.txt"

aws cloudfront create-invalidation \
  --distribution-id "$distribution" \
  --invalidation-batch '{"Paths":{"Quantity":1,"Items":["/*"]},"CallerReference":"deploy-'"$(date +%s)"'"}'
