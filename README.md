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
    containers/     # Script runtime: base images, job launcher, SDK, image build kit
    docker-files/   # Firmware analysis tooling and Docker setup
    Local_GUI/      # Python desktop GUI for demos and local tooling
    bluetooth-sniffer/  # Adafruit BLE sniffer (vendored)
    logs-n-pcaps/   # Captured sample traffic and logs
  scripts/          # Maintenance scripts (migration, seeding, budgets) and end-to-end checks
docs/               # Project documentation (architecture, diagrams, presentations)
.devcontainer/      # Standardized development environment (VS Code)
```

## High-Level Architecture
- Web frontend served as a static site via **S3 + CloudFront** (client-side rendering)
- **API Gateway** (REST) routes authenticated requests to backend **Lambda** functions
- **DynamoDB** stores platform metadata (`-metadata`: devices, artifacts, upload batches, ownership links) and user
  records (`-users`). The metadata table is a single-table design, documented in
  [`Platform/infra/DATABASE.md`](Platform/infra/DATABASE.md)
- **S3** stores uploaded files ("artifacts": firmware, pcaps, logs, binaries) in a data lake bucket, and the static
  frontend in a separate web bucket. Neither bucket is public
- **Cognito** handles user authentication; API Gateway authorizes requests against the user pool
- **CodeBuild** builds users' scripts and tool environments into container images, stored in **ECR**
- **AWS Batch** (Fargate, optionally EC2) runs scripts in bulk over artifacts, in a private network with no internet
  and no AWS credentials; jobs reach their files only through a private manifest API
- **EventBridge** feeds build and job state changes to Lambdas that track status, meter usage and enforce budgets
- Infrastructure is managed entirely via **Terraform** — no manual console changes

### Canonical Host

The site is served at **https://vzoniq.com**. The CloudFront distribution also answers on `www.vzoniq.com`
and its default `*.cloudfront.net` domain, but a viewer-request function **301-redirects both to the apex**,
preserving path and query string.

This is deliberate. The API Gateway responses, Lambda responses, and the data lake bucket's CORS rule each
pin a single allowed origin (`https://vzoniq.com`). An app served on a second hostname would load fine but
have every API call and file upload blocked by the browser's CORS check. Collapsing to one canonical
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

All three are required — every API call throws at runtime if `NEXT_PUBLIC_API_URL` is unset.

Note that API calls from `localhost:3000` reach API Gateway, but only `http://localhost:3000` is in the
data lake bucket's CORS allowlist, so direct-to-S3 uploads work locally only from that exact origin.

### Build
```bash
npm run build   # outputs static files to Platform/services/web/out/
```

### Routes
| Route | Purpose |
|---|---|
| `/` | Device dashboard — list/create devices, upload and list firmware |
| `/artifacts` | Upload files in bulk (multi-select, drag-and-drop or a whole folder), browse, filter and download them; pick files to run a script on |
| `/scripts` | Upload analysis scripts (L1 `.py`, L2 `.zip`, L3 `.zip` + Dockerfile, or local-only), see builds, logs and installed packages |
| `/environments` | Build tool environments from the catalog (radare2, GDB, Ghidra, …) that scripts run on |
| `/runs` | Start a bulk run (inputs, grouping, class, size, estimate), follow its progress, logs and outputs; `/runs?id=…` for one run |
| `/usage` | Monthly budget, metered usage and the ledger |
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

## Device & Artifact API

API Gateway (REST) fronts the Lambdas below. All routes require a Cognito authorizer, and every handler
checks that the caller owns the device or artifact before acting on it.

| Method | Path | Lambda | Purpose |
|---|---|---|---|
| `GET` | `/devices` | `list-devices` | List the caller's devices |
| `POST` | `/devices` | `create-device` | Register a device (UUIDv4 `deviceId`) |
| `POST` | `/artifacts/presign` | `artifacts-presign` | Register up to 100 files and return upload instructions |
| `POST` | `/artifacts/{artifactId}/parts` | `artifacts-presign` | Presigned URLs for up to 100 multipart parts |
| `POST` | `/artifacts/{artifactId}/retry` | `artifacts-presign` | Start a new upload attempt for a pending, failed or stalled upload |
| `POST` | `/artifacts/complete` | `artifacts-complete` | Verify up to 100 uploads and mark them ready (or verifying) |
| `GET` | `/artifacts` | `artifacts-list` | List the caller's artifacts (`type`, `tag`, `batchId`, `limit`, `nextToken`) |
| `GET` | `/devices/{deviceId}/artifacts` | `artifacts-list` | List a device's artifacts (`type`, `tag`, `limit`, `nextToken`) |
| `GET` | `/artifacts/{artifactId}` | `artifacts-get` | Artifact details and linked devices |
| `GET` | `/artifacts/{artifactId}/download` | `artifacts-get` | Short-lived presigned download URL |

`artifacts-verify` has no route: `artifacts-complete` invokes it asynchronously to check multipart uploads.

The older firmware routes (`/devices/{deviceId}/firmware`, `…/presign`, `…/{version}/complete`) are still
deployed but no longer used by the web app; firmware now goes through the artifact routes with
`type = firmware`. They can be removed once the firmware migration below has been run.

### Artifacts

An **artifact** is any stored file: `firmware`, `pcap`, `log`, `binary` or `other`. Each one can carry tags
and be linked to any number of the caller's devices. Firmware needs a version, which is unique per device.
Files sent together form an **upload batch**, which can be listed on its own. Records and keys are described
in [`Platform/infra/DATABASE.md`](Platform/infra/DATABASE.md).

### Upload Flow

1. The browser hashes each file (streaming SHA-256 with `hash-wasm`, so large files never have to fit in
   memory) and registers up to 100 files per `/artifacts/presign` call.
2. For each file the Lambda writes the artifact, ownership, batch and device-link rows in one transaction, and
   returns either:
   - **single** (up to 25 MiB): a presigned S3 POST whose policy pins the exact size, `Content-Type`, the
     Base64 SHA-256 and a `upload-state=pending` tag. S3 checks the bytes against the digest as it writes them.
   - **multipart** (up to 5 GiB): a part size (at least 16 MiB, at most 1000 parts). The browser hashes each
     part and asks `/artifacts/{id}/parts` for presigned `UploadPart` URLs with the part's SHA-256 signed in,
     so S3 rejects any part whose bytes don't match.
3. The browser sends the bytes **directly to S3**, then calls `/artifacts/complete`:
   - single uploads: `HeadObject` confirms S3's stored `ChecksumSHA256` and size, and the artifact becomes `ready`;
   - multipart uploads: the part list is checked and the upload assembled. S3 can only attest per-part SHA-256
     for these, so the artifact is `verifying` until `artifacts-verify` has streamed the object and checked the
     full SHA-256. The browser keeps calling complete while it waits, which also re-starts a check that has
     stalled for 20 minutes.
4. A `ready` object is re-tagged `upload-state=committed`.

Status is `pending → ready` (single) or `pending → verifying → ready` (multipart), or `failed`. A pending,
failed or stalled upload can be retried, which issues a new attempt id and S3 key.

The web app uploads about 3 files at a time and 4 parts per multipart file, retries network errors, refreshes
an expired presigned URL once, and lets the user retry only the files that failed.

Limits and timings are Lambda environment variables in `Platform/infra/envs/dev/artifacts.tf`:

| Variable | Value | Meaning |
|---|---|---|
| `MAX_ARTIFACT_SIZE_BYTES` | 5 GiB | Largest file |
| `SINGLE_UPLOAD_MAX_BYTES` | 25 MiB | Larger files use multipart |
| `PRESIGN_EXPIRES_SEC` | 3600 | Presigned POST lifetime |
| `PART_URL_EXPIRES_SEC` | 900 | Presigned part URL lifetime |
| `VERIFY_STALE_SEC` | 1200 | When a `verifying` upload counts as stalled |
| `DOWNLOAD_EXPIRES_SEC` | 300 | Download URL lifetime |

The data lake bucket has two lifecycle rules: incomplete multipart uploads are aborted after **1 day**, and
objects under `artifacts/` still tagged `upload-state=pending` are deleted after **7 days**. That removes
superseded retry attempts and abandoned uploads without touching verified files.

### Firmware Migration

Firmware uploaded before artifacts existed is stored as `DEVICE#/FIRMWARE#` rows. Copy it into artifacts
once, after the artifact routes are deployed (it only appears in the new firmware list after this):

```bash
python3 Platform/scripts/migrate_firmware_to_artifacts.py --table healthcare-iot-testbed-dev-metadata          # dry run
python3 Platform/scripts/migrate_firmware_to_artifacts.py --table healthcare-iot-testbed-dev-metadata --apply
```

S3 objects stay where they are and the old rows are left in place. The script is safe to run again: versions
that already exist as artifacts are skipped.

### End-to-End Check

`Platform/scripts/e2e/step1_artifacts.py` runs the upload checks against the deployed API (single and
multipart uploads, a tampered part, a wrong declared SHA-256, device ownership, duplicate firmware versions,
and a 250-file batch with one corrupted file). It needs a Cognito ID token for a test user; see the script's
docstring.

```bash
API_URL=<api_invoke_url output> ID_TOKEN=<id token> DEVICE_ID=<a device you own> \
  python3 Platform/scripts/e2e/step1_artifacts.py --multipart-mb 200 --batch-files 250
```

It leaves its test files (tagged `e2e`) in place, as there is no delete endpoint yet.

## Scripts, Environments and Runs

Users analyse their artifacts with their own scripts, run in bulk in a sandbox. How to write a script (the
three levels, the `ctx` API, the variables an L3 image receives, trying scripts locally) is in
[`Platform/services/containers/README.md`](Platform/services/containers/README.md).

| Method | Path | Lambda | Purpose |
|---|---|---|---|
| `GET`/`POST` | `/modules` | `builds-api` | List / create scripts (`runtime`: `cloud` or `local`) |
| `GET` | `/modules/{moduleId}` | `builds-api` | Script and its versions |
| `POST` | `/modules/{moduleId}/versions` | `builds-api` | New version: returns a presigned upload for the source |
| `POST` | `/modules/{moduleId}/versions/{version}/complete` | `builds-api` | Verify and validate the upload, start the build |
| `GET` | `/modules/{moduleId}/versions/{version}/{download,log,packages}` | `builds-api` | Source, build log, pip/dpkg package lists |
| `GET`/`POST` | `/environments` | `builds-api` | Platform + own environments / create one from catalog tools |
| `GET` | `/environments/catalog` | `builds-api` | Tools that can be added |
| `GET` | `/environments/{envId}` | `builds-api` | Environment and its versions |
| `POST` | `/environments/{envId}/versions` | `builds-api` | New version with more tools |
| `GET` | `/environments/{envId}/versions/{version}/{log,packages}` | `builds-api` | Build log, package lists |
| `POST` | `/runs/estimate` | `runs-api` | Preview: matched files, work units, jobs, expected and maximum cost, budget |
| `GET`/`POST` | `/runs` | `runs-api` | List / start runs |
| `GET` | `/runs/{runId}` | `runs-api` | Run, job summary and failed work units |
| `POST` | `/runs/{runId}/cancel` | `runs-api` | Cancel |
| `GET` | `/runs/{runId}/children/{index}/log` | `runs-api` | A job's log |
| `GET` | `/artifacts?runId=…`, `/artifacts/batches` | `artifacts-list` | A run's outputs; recent upload batches (run input picker) |
| `GET` | `/usage?period=YYYY-MM` | `usage-api` | Budget and usage ledger |

Not on the public API: `builds-events`, `runs-events` and `usage-meter` (EventBridge targets),
`run-watchdog` (every 5 minutes), and `runs-manifest` (the private API jobs call).

### Builds

A script version is validated before anything is built:
- **L1:** syntax, `run(ctx)` and its PEP 723 dependencies.
- **L2 and L3:** the zip's file list (size, file count, compression ratio, unsafe paths, standard-library name clashes), the entrypoint, and `platform.json`.

A version that fails is `rejected`, with the reason. Otherwise `builds-api` starts a CodeBuild build of
`Platform/services/containers/buildkit`, which:
- builds the image `FROM` the chosen environment (L1/L2), or from the user's Dockerfile (L3);
- adds the launcher and SDK;
- pushes the image to ECR and records the installed packages.

`builds-events` marks the version `ready` and registers its Batch job definition. Environments are built the same
way, from a platform environment plus the catalog tools in `buildkit/catalog.json`.

The build project's role has no S3 access at all: sources, the build kit and the package lists move through
presigned URLs. User build steps can't reach the role, because build containers are firewalled off from the
credential endpoints.

### Runs

1. **Choosing inputs.** A run's inputs are chosen by upload batch, device, type/tag filter, hand-picked files,
   or the outputs of an earlier run. At start they're fixed into a list of up to 2000 ready files.
2. **Work units.** The files are split into work units:
   - `map`: one file each
   - `groupBy`: files sharing a folder, file name, pattern match or tag, e.g. a log and a pcap from the same test, optionally requiring certain types
   - `chunk`: fixed-size batches
   - `all`: every file at once

   Units are packed into Batch array jobs.
3. **Class and size.** The class picks the queue:
   - Economy: Fargate Spot, overflowing to on-demand
   - Standard: Fargate on-demand
   - Heavy: dedicated EC2, when enabled

   The size (S to XL) picks vCPU and memory.
4. **Inside each job.** Jobs run in private subnets with no internet and no IAM role. The launcher fetches the
   job's units from the private manifest API with the run's token, then for each unit:
   1. downloads the inputs through presigned links and checks their SHA-256;
   2. runs the script;
   3. uploads the outputs the same way, as new artifacts linked to their inputs.

   Results are recorded per unit, so a retried job (after a Spot interruption, for example) skips finished units.
5. **Cost.** Before a run starts, its maximum cost is held against the user's monthly budget:
   - maximum cost = jobs × timeout × on-demand rate
   - the expected cost comes from the script's earlier runs

   `usage-meter` records the provisional cost of every finished job and build in the usage ledger.
   `run-watchdog` stops runs that reach their maximum cost or the budget.

Defaults: a $25 monthly budget per user (`default_monthly_limit`), and the Heavy class off. An admin changes a
user's budget, or turns on Heavy for them, with:

```bash
python3 Platform/scripts/set_budget.py --table healthcare-iot-testbed-dev-metadata --user-id <cognito sub> --monthly-limit 100 --heavy on
```

The Heavy class itself is created by setting the Terraform variable `enable_heavy_class = true`. It adds EC2
compute and three more VPC endpoints, about $22/month.

### Standing Costs

The run network's interface endpoints (`ecr.api`, `ecr.dkr`, `logs`, `execute-api`) cost about $7 per endpoint
per availability zone per month. The network uses a single zone (`az_count = 1` in `runs.tf`), so that's roughly
$29/month, even when nothing runs; if that zone has an outage, runs wait until it recovers. Batch, CodeBuild
and Fargate cost nothing while idle.

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
  modules/          # api_gateway, api_gateway_route, api_lambda_method,
                    # api_cors_preflight, cloudfront, cognito, dynamodb,
                    # lambda, network, s3_bucket
  envs/
    dev/            # Deployed to real AWS (S3 remote state)
      main.tf       # buckets, tables, Cognito, CloudFront, API, devices, firmware
      artifacts.tf  # artifact Lambdas, IAM and routes
      builds.tf     # ECR, CodeBuild, scripts and environments
      runs.tf       # run network, AWS Batch, private manifest API, runs
      usage.tf      # metering, watchdog, usage API
```

`dev` is currently the only environment. State is stored in S3, so any Terraform command requires an
active SSO session.

### Notes
- DynamoDB tables are created with `deletion_protection_enabled = true` hardcoded in the module.
  Removing a table therefore takes two passes, or a manual
  `aws dynamodb update-table --no-deletion-protection-enabled` first.
- `modules/dynamodb_local/` is an unused leftover and is not referenced by any environment.
- Nested routes (anything below the top level, or with a path parameter) use `api_lambda_method` and
  `api_cors_preflight`, as in `artifacts.tf`. The older `api_gateway_route` module only works for top-level paths.
- Each Lambda gets its own narrowly scoped IAM policy rather than a shared one.

### Deploying Infrastructure (CI/CD)
Infrastructure is deployed automatically via **GitHub Actions** on every push to `main` that changes files under `Platform/infra/`.

GitHub Actions authenticates to AWS via **OIDC** (no long-lived credentials). Required GitHub secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | IAM role ARN with deployment permissions |
| `AWS_REGION` | AWS region (e.g. `us-east-2`) |

The deploy role's policy is managed in the AWS console, not in this repo. Besides creating resources, it needs
the actions Terraform uses to **change and remove** them. For the project's IAM roles and policies that
includes `iam:ListInstanceProfilesForRole` (checked before any role is deleted), `iam:CreatePolicyVersion`
(to edit a policy) and `iam:DeletePolicyVersion` (to delete an edited policy). Without them, a deploy that
removes a Lambda or changes its permissions fails with a 403.

For step 2 (scripts and runs) the deploy role also needs, scoped to `healthcare-iot-testbed-dev-*` names where
the service allows it:
- **EC2/VPC:** VPC, subnets, route tables, security groups and their rules, VPC endpoints and endpoint policies; launch templates if Heavy is enabled
- **ECR:** repositories and lifecycle policies
- **CodeBuild:** projects
- **AWS Batch:** compute environments and job queues
- **EventBridge:** rules and targets
- **IAM:** instance profiles (Heavy only), and `iam:CreateServiceLinkedRole` for Batch, ECS and Spot
- **CloudWatch Logs:** `logs:*` on `/aws/batch/healthcare-iot-testbed-dev-*` and `/aws/codebuild/healthcare-iot-testbed-dev-*`, alongside the existing `/aws/lambda/…` groups

New accounts start with low Fargate and Spot vCPU quotas; request increases before running large jobs.

### Deploying the Platform Images (CI/CD)
`deploy-images.yml` runs on pushes to `main` that change `Platform/services/containers/{base,ghidra,launcher,sdk}`
(or by hand). It:
1. builds the analysis-base and platform-ghidra images and pushes them to ECR;
2. records them as new versions of the `platform-base` and `platform-ghidra` environments with
   `Platform/scripts/seed_platform_envs.py`.

Builds can't start until `platform-base` has a version, so on a fresh environment run it once, by hand, after the
first infrastructure deploy. It needs the deploy role to allow ECR push to the platform-base repository, and
DynamoDB and S3 writes to the metadata table and `builds/*`.

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

All five workflows authenticate via the same OIDC role.
