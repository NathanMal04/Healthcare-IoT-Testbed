#!/bin/bash
# Show LocalStack service status in a human-readable format

ENDPOINT="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"

response=$(curl -s "$ENDPOINT/_localstack/health" 2>/dev/null)

if [ -z "$response" ]; then
  echo "LocalStack is not reachable at $ENDPOINT"
  exit 1
fi

echo "$response" | python3 -c "
import sys, json

data = json.load(sys.stdin)
services = data['services']
edition = data.get('edition', 'unknown')
version = data.get('version', 'unknown')

print(f'LocalStack {edition} v{version}')
print()

available = {k: v for k, v in sorted(services.items()) if v == 'available'}

print(f'Running ({len(available)}):')
for name in available:
    print(f'  + {name}')
    
print()
"
