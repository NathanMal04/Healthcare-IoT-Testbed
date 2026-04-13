#!/bin/bash
# Waits for LocalStack to be ready, then provisions the local infrastructure.

ENDPOINT="http://localstack:4566"
LOCAL_DIR="/workspaces/Healthcare-IoT-Testbed/Platform/infra/envs/local"

echo "Waiting for LocalStack to be ready..."
until curl -s "$ENDPOINT/_localstack/health" | grep -q '"running"'; do
  sleep 2
done
echo "LocalStack is ready."

cd "$LOCAL_DIR" || exit 1

# Initialize Terraform if not already done
if [ ! -d ".terraform" ]; then
  echo "Initializing Terraform..."
  terraform init
fi

# Apply the local infrastructure
echo "Applying local infrastructure..."
terraform apply -auto-approve

echo ""
echo "Syncing local infrastructure..."
terraform apply -auto-approve -refresh-only

echo ""
echo "Local stack is up. Resources:"
terraform output
