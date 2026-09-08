# Healthcare IoT Vulnerability Testbed

## Overview
This repository contains the source code and infrastructure for the **Healthcare IoT Vulnerability Testbed** senior design project.
The goal is to provide a controlled platform for collecting, analyzing, and testing the security of healthcare and IoT devices.

## Repository Structure

```
Platform/
  infra/            # Terraform infrastructure (modules + per-environment configs)
  services/
    web/            # Next.js frontend (static export)
    lambdas/        # Python Lambda handlers behind API Gateway
    docker-files/   # Firmware analysis tooling and Docker setup
    Local_GUI/      # Python desktop GUI for demos and local tooling
    bluetooth-sniffer/  # Adafruit BLE sniffer (vendored)
    logs-n-pcaps/   # Captured sample traffic and logs
docs/               # Project documentation (architecture, diagrams, presentations)
.devcontainer/      # Standardized development environment (VS Code)
```

## High-Level Architecture
- Web frontend served as a static site via **S3 + CloudFront** (client-side rendering)
- **API Gateway** (REST) routes authenticated requests to backend **Lambda** functions
- **DynamoDB** stores device and firmware metadata (`-metadata`) and user records (`-users`), both single-table designs
- **S3** stores user-uploaded files (firmware, logs) in a data lake bucket and the static frontend in a separate web bucket
- **Cognito** handles user authentication; API Gateway authorizes requests against the user pool
- Infrastructure is managed entirely via **Terraform** — no manual console changes

### Canonical Host

The site is served at **https://vzoniq.com**. The CloudFront distribution also answers on `www.vzoniq.com`
and its default `*.cloudfront.net` domain, but a viewer-request function **301-redirects both to the apex**,
preserving path and query string.

This is deliberate. The API Gateway responses, Lambda responses, and the data lake bucket's CORS rule each
pin a single allowed origin (`https://vzoniq.com`). An app served on a second hostname would load fine but
have every API call and firmware upload blocked by the browser's CORS check. Collapsing to one canonical
origin keeps that invariant in one place instead of maintaining an origin allowlist across three layers.

If a new hostname is ever needed, it must be added to **all** of:
- `canonical_host` / the redirect logic in `Platform/infra/modules/cloudfront/`
- `allowed_origins` on the data lake bucket CORS rule
- the `Access-Control-Allow-Origin` values in the API Gateway OPTIONS integrations and gateway responses
- the `Access-Control-Allow-Origin` header in each Lambda's response helper

## Development Environment

This project uses **VS Code Dev Containers** to standardize tooling. The container ships the AWS CLI, Terraform, Python and Node, and points `AWS_CONFIG_FILE` at the profile checked in at `.devcontainer/aws/config`.

There is no local AWS emulation — development runs against the real `dev` environment in AWS.

### Requirements
- [Docker](https://www.docker.com/)
- [VS Code](https://code.visualstudio.com/)
- [VS Code Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- Access to the project AWS account via IAM Identity Center (SSO)

### Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/NathanMal04/Healthcare-IoT-Testbed
   cd Healthcare-IoT-Testbed
   ```

2. **Open in the devcontainer**
   - Open the repo in VS Code
   - Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Select **Dev Containers: Reopen in Container**

3. **Authenticate to AWS**
   ```bash
   aws sso login
   aws sts get-caller-identity   # confirms the session works
   ```
   The `Healthcare-IoT-Dev` profile is preselected via `AWS_PROFILE`, so no `--profile` flag is needed.

4. **Read the deployed infrastructure values**
   ```bash
   cd Platform/infra/envs/dev
   terraform init      # state lives in S3, so this needs an active SSO session
   terraform output
   ```

## Web Frontend

The frontend is a **Next.js 14** app (App Router) configured for static export (`output: 'export'`),
served via S3 + CloudFront at **vzoniq.com**. Styling is Tailwind CSS.

### Local Development
```bash
cd Platform/services/web
npm install
npm run dev
```

Create a `.env` file in `Platform/services/web/` with values from `terraform output` in `Platform/infra/envs/dev/`:
```
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<cognito_user_pool_id output>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<cognito_user_pool_client_id output>
NEXT_PUBLIC_API_URL=<api_invoke_url output>
```

All three are required — the device and firmware calls throw at runtime if `NEXT_PUBLIC_API_URL` is unset.

Note that API calls from `localhost:3000` reach API Gateway, but only `http://localhost:3000` is in the
data lake bucket's CORS allowlist, so direct-to-S3 firmware uploads work locally only from that exact origin.

### Build
```bash
npm run build   # outputs static files to Platform/services/web/out/
```

### Routes
| Route | Purpose |
|---|---|
| `/` | Device dashboard — list/create devices, upload and list firmware |
| `/login` | Sign in |
| `/signup` | Register |
| `/confirm` | Email verification via 6-digit code |

## Authentication

Authentication is handled by **AWS Cognito** using the Amplify v6 library.

- Sign up / sign in via custom forms at `/signup` and `/login`
- Email is used as the username
- Email verification required via 6-digit code (`/confirm`)
- Session state managed via `AuthContext` — unauthenticated users are redirected to `/login`
- The user pool client uses **SRP** (`ALLOW_USER_SRP_AUTH`); the Cognito hosted UI is **not** configured,
  so the `callback_urls` / `logout_urls` variables are currently inert
- A **post-confirmation** Lambda writes a user record to the users table on first confirmation

## Device & Firmware API

API Gateway (REST) fronts the Lambdas below. All routes require a Cognito authorizer, and every handler
checks that the caller owns the device before acting on it.

| Method | Path | Lambda | Purpose |
|---|---|---|---|
| `GET` | `/devices` | `list-devices` | List the caller's devices |
| `POST` | `/devices` | `create-device` | Register a device (UUIDv4 `deviceId`) |
| `GET` | `/devices/{deviceId}/firmware` | `list-firmware` | List firmware versions for a device |
| `POST` | `/devices/{deviceId}/firmware/presign` | `presign-firmware` | Reserve a version, return a presigned S3 POST |
| `POST` | `/devices/{deviceId}/firmware/{version}/complete` | `complete-firmware` | Verify the upload and mark it ready |
| `POST` | `/uploads/presign` | `uploads-presign` | Generic presigned upload |
| `POST` | `/uploads/complete` | `uploads-complete` | Generic upload completion |

### Firmware Upload Flow

1. The browser hashes the file (SHA-256) and calls `/firmware/presign` with the version, filename, size and digest.
2. The Lambda reserves the version in DynamoDB (`status: pending`) and returns a **presigned S3 POST** whose
   policy pins `Content-Type`, the checksum algorithm, the Base64 digest, and a content-length range.
3. The browser POSTs the bytes **directly to S3**. S3 verifies the checksum at write time, so a client cannot
   substitute different bytes than it declared.
4. The browser calls `/firmware/{version}/complete`, which `HeadObject`s the upload, compares S3's computed
   `ChecksumSHA256` against the digest stored in DynamoDB, and flips the record to `ready`.

Limits are set via Lambda environment variables in Terraform: **25 MiB** max firmware size
(`MAX_FIRMWARE_SIZE_BYTES`) and **300 s** presigned URL expiry (`PRESIGN_EXPIRES_SEC`).

## Firmware Analysis Tooling

`Platform/services/docker-files/` contains a Docker image and analysis scripts run against uploaded firmware:

| Script | Purpose |
|---|---|
| `parse_firmware.py` | Extract and inspect firmware images |
| `analyze_entropy.py` | Entropy analysis (packing/encryption detection) |
| `buffer_overflow_scanner.py` | Scan for buffer overflow patterns |
| `rop_gadgets_scanner.py` | Locate ROP gadgets |
| `unsanitized_text_entries_scanner.py` | Find unsanitized input handling |
| `analyze_bluetooth_pcap.py` | Analyze captured BLE traffic |
| `lambda_invoke.py` | Invoke the analysis pipeline from Lambda |

See `Platform/services/docker-files/README.md` for build and run instructions.

## Infrastructure

Terraform is split into reusable **modules** and per-environment **configs**:

```
Platform/infra/
  modules/          # api_gateway, api_gateway_route, cloudfront, cognito,
                    # dynamodb, lambda, s3_bucket
  envs/
    dev/            # Deployed to real AWS (S3 remote state)
```

`dev` is currently the only environment. State is stored in S3, so any Terraform command requires an
active SSO session.

### Notes
- DynamoDB tables are created with `deletion_protection_enabled = true` hardcoded in the module.
  Removing a table therefore takes two passes, or a manual
  `aws dynamodb update-table --no-deletion-protection-enabled` first.
- `modules/dynamodb_local/` is an unused leftover and is not referenced by any environment.

### Deploying Infrastructure (CI/CD)
Infrastructure is deployed automatically via **GitHub Actions** on every push to `main` that changes files under `Platform/infra/`.

GitHub Actions authenticates to AWS via **OIDC** (no long-lived credentials). Required GitHub secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with deployment permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-2`) |

### Deploying the Web Frontend (CI/CD)
Frontend is deployed automatically on every push to `main` that changes files under `Platform/services/web/`.

The workflow reads the S3 bucket name, CloudFront distribution ID, Cognito IDs, and API URL directly from
`terraform output` — no need to store them as secrets. It builds the static export, syncs to S3 (long cache
for assets, `no-cache` for HTML), and invalidates the CloudFront distribution. Only AWS access requires secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with S3 + CloudFront permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-2`) |

### Pull Request Checks
| Workflow | Trigger | Action |
|---|---|---|
| `terraform-pr-check.yml` | PRs touching `Platform/infra/**` | `terraform plan` against `dev` |
| `frontend-pr-check.yml` | PRs touching `Platform/services/web/**` | Build the frontend |

All four workflows authenticate via the same OIDC role.
