# Healthcare IoT Vulnerability Testbed

## Overview
This repository contains the source code and infrastructure for the **Healthcare IoT Vulnerability Testbed** senior design project.  
The goal of this project is to provide a controlled platform for collecting, analyzing, and testing the security of healthcare and IoT devices.

## High-Level Architecture
- AWS VPC with **Public** and **Private** subnets
- Web frontend served as a static site via **S3 + CloudFront** (client-side rendering)
- Private subnet hosts backend services (ECS, Lambda)
- DynamoDB stores device data
- S3 stores user-uploaded scripts and the static web build



### Folder Responsibilities
- **infra/**  
  Source of truth for all AWS infrastructure. No manual changes in the AWS console.

- **services/**  
  Application code that runs on AWS (containers and Lambda functions).

- **data-contracts/**  
  Defines shared data formats used across services (API schemas, DB schemas).

- **scripts/**  
  Non-deployable helper scripts for development and operations.

- **docs/**  
  Project documentation, diagrams, and operational guides.

## Repository Structure

```
platform/
  infra/            # Infrastructure as Code
  services/         # Deployable services
  scripts/          # Helper scripts
docs/               # Architecture docs, runbooks, decision records
.devcontainer/      # Standardized development environment
```

## Development Environment
This project uses **VS Code Dev Containers** to standardize tooling across the team.

### Requirements
- Docker
- VS Code
- VS Code Dev Containers extension
- AWS credentials (via IAM Identity Center or named profiles)

### Getting Started
1. Clone the repository
2. Open the repo in VS Code
3. Reopen the project in the provided container
    - Open the Command Pallette (`Ctrl+Shift+P`)
    - Select **`Dev Containers: Reopen in Container`**
4. Log in to AWS SSO and verify access:
    ```bash
    aws sso login
    aws sts get-caller-identity
    ```

## Web Frontend

The web frontend is a **Next.js** app configured for static export (client-side rendering only), served at **vzoniq.com** via S3 + CloudFront.

### Local Development
```bash
cd Platform/services/web
npm install
npm run dev
```

Create a `.env` file in `Platform/services/web/` with:
```
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<your-user-pool-id>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<your-app-client-id>
```

### Build
```bash
npm run build   # outputs static files to Platform/services/web/out/
```

### Deployment
Deployment is automated via **GitHub Actions** on every push to `main` that changes files under `Platform/services/web/`.

The workflow (`.github/workflows/deploy-web.yml`):
1. Builds the Next.js static export
2. Syncs the `out/` folder to S3
3. Invalidates the CloudFront distribution cache

GitHub Actions authenticates to AWS via **OIDC** (no long-lived credentials). Required GitHub secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with S3 + CloudFront permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `S3_BUCKET_NAME` | S3 bucket hosting the static site |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront distribution ID |

## Authentication

Authentication is handled by **AWS Cognito** using the Amplify v6 library.

- Users sign up and sign in via custom forms at `/signup` and `/login`
- Email is used as the username (Cognito User Pool sign-in: email only)
- Email verification is required via a 6-digit code sent to the user (`/confirm`)
- Session state is managed via `AuthContext` — the dashboard redirects to `/login` if unauthenticated
- Sign out is available in the navbar
