#!/usr/bin/env bash
# Deploys the platform to your own AWS account from your machine (or the
# devcontainer). The step-by-step guide is SELF_HOSTING.md.
#
#   Platform/scripts/deploy.sh bootstrap   # once per account: state bucket + GitHub deploy role
#   Platform/scripts/deploy.sh infra       # Terraform (envs/dev), including the certificate
#   Platform/scripts/deploy.sh images      # platform images (needs Docker)
#   Platform/scripts/deploy.sh web         # build and publish the web app
#   Platform/scripts/deploy.sh all         # infra, images, web
#
# Uses your current AWS credentials (AWS_PROFILE etc.). Terraform asks before
# applying; set DEPLOY_AUTO_APPROVE=true to skip that.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$(cd "$SCRIPTS/../infra" && pwd)"
ENV_DIR="$INFRA/envs/dev"
BOOT_DIR="$INFRA/bootstrap"

approve=()
[[ "${DEPLOY_AUTO_APPROVE:-}" == "true" ]] && approve=(-auto-approve)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
tf() { terraform -chdir="$ENV_DIR" "$@"; }

bootstrap() {
  [[ -f "$BOOT_DIR/terraform.tfvars" ]] ||
    die "create $BOOT_DIR/terraform.tfvars first (copy terraform.tfvars.example)"
  say "Bootstrap: state bucket and GitHub deploy role"
  terraform -chdir="$BOOT_DIR" init -input=false
  terraform -chdir="$BOOT_DIR" apply "${approve[@]}"

  if [[ -f "$ENV_DIR/backend.hcl" ]]; then
    say "Keeping the existing envs/dev/backend.hcl"
  else
    terraform -chdir="$BOOT_DIR" output -raw backend_hcl > "$ENV_DIR/backend.hcl"
    say "Wrote envs/dev/backend.hcl"
  fi

  local role bucket region
  role="$(terraform -chdir="$BOOT_DIR" output -raw deploy_role_arn 2>/dev/null || true)"
  bucket="$(terraform -chdir="$BOOT_DIR" output -raw state_bucket)"
  region="$(grep -E '^\s*region\s*=' "$ENV_DIR/backend.hcl" | sed -E 's/.*"(.*)".*/\1/')"
  if [[ -n "$role" ]]; then
    cat <<EOF

GitHub Actions setup for your fork (run these, or set them under
Settings > Secrets and variables > Actions):

  gh secret set AWS_ROLE_ARN --body '$role'
  gh secret set AWS_REGION --body '$region'
  gh variable set TF_STATE_BUCKET --body '$bucket'
  gh variable set TF_USE_LOCKFILE --body 'true'
  gh variable set TF_NAME --body '<name from envs/dev/terraform.tfvars>'
  gh variable set DOMAIN_NAME --body '<domain_name from envs/dev/terraform.tfvars>'
  # optional: gh variable set ROUTE53_ZONE_ID --body '<zone id>'
  # optional: gh variable set BRAND_NAME --body '<product name>'
EOF
  fi
}

# Prints a Terraform variable's value as envs/dev sees it (terraform.tfvars,
# TF_VAR_*, defaults). Evaluated in a scratch module with only the variable
# declarations, so it needs no state, backend or providers.
tf_var() {
  local tmp value
  tmp="$(mktemp -d)"
  cp "$ENV_DIR/variables.tf" "$tmp/"
  [[ -f "$ENV_DIR/terraform.tfvars" ]] && cp "$ENV_DIR/terraform.tfvars" "$tmp/"
  value="$(echo "var.$1" | terraform -chdir="$tmp" console)"
  rm -rf "$tmp"
  echo "$value" | tr -d '"'
}

cert_status() {
  aws acm describe-certificate --region us-east-1 --certificate-arn "$1" --query Certificate.Status --output text
}

infra() {
  [[ -f "$ENV_DIR/terraform.tfvars" || -n "${TF_VAR_domain_name:-}" ]] ||
    die "create $ENV_DIR/terraform.tfvars first (copy terraform.tfvars.example)"
  say "Terraform init"
  "$SCRIPTS/tf_init.sh"

  if [[ -z "$(tf_var route53_zone_id)" ]]; then
    # Manual DNS: CloudFront can't use the certificate until it is issued, so
    # create it first and wait for its validation records to be added.
    say "Certificate (DNS is managed by hand)"
    local arn
    arn="$(tf output -raw acm_certificate_arn 2>/dev/null || true)"
    if [[ -z "$arn" || "$(cert_status "$arn")" != "ISSUED" ]]; then
      tf apply -target=aws_acm_certificate.frontend "${approve[@]}"
      arn="$(tf output -raw acm_certificate_arn 2>/dev/null ||
        tf state show -no-color aws_acm_certificate.frontend | sed -nE 's/^ *arn *= *"(.*)"/\1/p' | head -1)"
    fi
    if [[ "$(cert_status "$arn")" != "ISSUED" ]]; then
      echo
      echo "Add these DNS records at your DNS provider to validate the certificate:"
      aws acm describe-certificate --region us-east-1 --certificate-arn "$arn" \
        --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Type,Name,Value]' --output table
      echo "Waiting for validation (this can take a few minutes after the records are added)..."
      until aws acm wait certificate-validated --region us-east-1 --certificate-arn "$arn" 2>/dev/null; do
        echo "...still waiting for $arn"
      done
    fi
    say "Certificate issued"
  fi

  say "Terraform apply"
  tf apply "${approve[@]}"

  if [[ -z "$(tf_var route53_zone_id)" ]]; then
    local target
    target="$(tf output -raw cloudfront_domain_name)"
    cat <<EOF

Point your site's hostnames at CloudFront (once; at your DNS provider):
  $(tf_var domain_name)  ->  $target   (ALIAS/ANAME at an apex domain, otherwise CNAME)
EOF
    [[ "$(tf_var include_www)" == "true" ]] && echo "  www.$(tf_var domain_name)  ->  $target   (CNAME)"
  fi
}

images() {
  say "Platform images"
  "$SCRIPTS/tf_init.sh" > /dev/null
  "$SCRIPTS/build_images.sh"
}

web() {
  say "Web app"
  "$SCRIPTS/tf_init.sh" > /dev/null
  "$SCRIPTS/deploy_web.sh"
}

case "${1:-}" in
  bootstrap) bootstrap ;;
  infra) infra ;;
  images) images ;;
  web) web ;;
  all) infra; images; web ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
