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
.devcontainer/      # Standardized development environment (VS Code + LocalStack)
```

## High-Level Architecture
- Web frontend served as a static site via **S3 + CloudFront** (client-side rendering)
- **API Gateway** routes requests to backend **Lambda** functions
- **DynamoDB** stores device data
- **S3** stores user-uploaded files (firmware, logs) and the static frontend
- **Cognito** handles user authentication
- Infrastructure is managed entirely via **Terraform** — no manual console changes

## Development Environment

This project uses **VS Code Dev Containers** to standardize tooling. The devcontainer starts a **LocalStack** sidecar that emulates AWS services locally so you can develop without touching the real AWS environment.

### Requirements
- [Docker](https://www.docker.com/)
- [VS Code](https://code.visualstudio.com/)
- [VS Code Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- A free [LocalStack account](https://app.localstack.cloud) (for the local AWS emulator)

### Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/NathanMal04/Healthcare-IoT-Testbed
   cd Healthcare-IoT-Testbed
   ```

2. **Set up your LocalStack auth token**

   Create a free account at [localstack.cloud](https://app.localstack.cloud) and get your token from [Settings > Auth Tokens](https://app.localstack.cloud/settings/auth-tokens).

   Create a `secrets.env` file at the **repo root** (this file is gitignored):
   ```
   LOCALSTACK_AUTH_TOKEN=your_token_here
   ```

3. **Open in the devcontainer**
   - Open the repo in VS Code
   - Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Select **Dev Containers: Reopen in Container**

   VS Code will build the container, start LocalStack, and automatically run Terraform to provision all local AWS resources.

4. **Verify LocalStack is running**
   ```bash
   .devcontainer/localstack/status.sh
   ```

5. **Check provisioned resources**
   ```bash
   cd Platform/infra/envs/local
   terraform output
   ```

### What Gets Provisioned Locally
| Resource | Description |
|---|---|
| S3 (`*-web`) | Frontend static site bucket |
| S3 (`*-data-lake`) | Firmware and log storage |
| DynamoDB | Device data table |
| Cognito User Pool | Auth for local testing |
| API Gateway | REST API endpoint |
| IAM Policy | Lambda → DynamoDB access |

## Web Frontend

The frontend is a **Next.js** app configured for static export, served via S3 + CloudFront at **vzoniq.com**.

### Local Development
```bash
cd Platform/services/web
npm install
npm run dev
```

Create a `.env` file in `Platform/services/web/` with values from `terraform output` in `Platform/infra/envs/local/`:
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
    local/          # Deployed to LocalStack
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

---

## BLE Sniffing (Adafruit Bluefruit LE Sniffer)

This project includes a Python API wrapper for [Adafruit's Bluefruit LE Sniffer](https://www.adafruit.com/product/2269), used to capture Bluetooth LE traffic from nearby IoT devices.

### Requirements
- **Python 2.7**
- **pySerial**

Tested on: OSX 10.10, Windows 7 x64, Windows 10 x86, Ubuntu 14.04.

### Usage

Run `sniffer.py` with the serial port of your sniffer device:

```bash
# macOS
python sniffer.py /dev/tty.usbmodem1412311

# Linux (requires sudo for log file creation)
sudo python sniffer.py /dev/ttyACM0

# Windows
python sniffer.py COM3
```

The sniffer will scan for nearby BLE devices for 5 seconds and present a numbered list. Select a device to begin capturing — traffic is logged to `logs/capture.pcap`, which can be opened in **Wireshark**.

Press **CTRL+C** to stop sniffing and close the log file.

> **Tip:** If you see unexpected errors, try unplugging and re-inserting the sniffer before starting a new session.

### Log File Location
| Platform | Default Path |
|---|---|
| Windows 10 | `C:\Users\YOUR_USERNAME\AppData\Roaming\Nordic Semiconductor\Sniffer\logs\` |
| macOS / Linux | `logs/capture.pcap` (relative to script directory) |

### Related Links
- [Bluefruit LE Sniffer Product Page](https://www.adafruit.com/product/2269)
- [Bluefruit LE Sniffer Learning Guide](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-sniffer/introduction)
- [Sniffer Firmware (Silicon Labs VCP Chipset Drivers)](https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers?tab=downloads)
