# Healthcare IoT Vulnerability Testbed

## Overview
This repository contains the source code and infrastructure for the **Healthcare IoT Vulnerability Testbed** senior design project.
The goal is to provide a controlled platform for collecting, analyzing, and testing the security of healthcare and IoT devices.

## Repository Structure

```
Platform/
  infra/            # Terraform infrastructure (modules + per-environment configs)
  services/
    web/            # Next.js frontend
    docker-files/     # Firmware analysis tooling and Docker setup
  scripts/          # Helper scripts for development and operations
docs/               # Project documentation (architecture, diagrams, presentations)
.devcontainer/      # Standardized development environment (VS Code)
```

## High-Level Architecture
- Web frontend served as a static site via **S3 + CloudFront** (client-side rendering)
- **API Gateway** routes requests to backend **Lambda** functions
- **DynamoDB** stores device data
- **S3** stores user-uploaded files (firmware, logs) and the static frontend
- **Cognito** handles user authentication
- Infrastructure is managed entirely via **Terraform** — no manual console changes

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

The frontend is a **Next.js** app configured for static export, served via S3 + CloudFront at **vzoniq.com**.

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
```

### Build
```bash
npm run build   # outputs static files to Platform/services/web/out/
```

## Authentication

Authentication is handled by **AWS Cognito** using the Amplify v6 library.

- Sign up / sign in via custom forms at `/signup` and `/login`
- Email is used as the username
- Email verification required via 6-digit code (`/confirm`)
- Session state managed via `AuthContext` — unauthenticated users are redirected to `/login`

## Infrastructure

Terraform is split into reusable **modules** and per-environment **configs**:

```
Platform/infra/
  modules/          # Reusable modules (s3_bucket, lambda, api_gateway, cognito, dynamodb, etc.)
  envs/
    dev/            # Deployed to real AWS
```

### Deploying Infrastructure (CI/CD)
Infrastructure is deployed automatically via **GitHub Actions** on every push to `main` that changes files under `Platform/infra/`.

GitHub Actions authenticates to AWS via **OIDC** (no long-lived credentials). Required GitHub secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with deployment permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |

### Deploying the Web Frontend (CI/CD)
Frontend is deployed automatically on every push to `main` that changes files under `Platform/services/web/`.

The workflow reads the S3 bucket name, CloudFront distribution ID, and Cognito IDs directly from `terraform output` — no need to store them as secrets. Only AWS access requires secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with S3 + CloudFront permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
