# Database

The platform stores its records in two DynamoDB tables. The sample model for both is [nosql-workbench-model.json](nosql-workbench-model.json).

| Table | Keys | Holds |
|---|---|---|
| `healthcare-iot-testbed-dev-users` | `userId` | One row per Cognito user: `email`, `fullName`, `role` (`admin` / `user`), `status`, timestamps. Written by the post-confirmation Lambda. |
| `healthcare-iot-testbed-dev-metadata` | `pk` + `sk` | Everything else, in a single-table design: devices, artifacts, upload batches, scripts (modules), environments, runs, sessions, ownership links, budgets and the usage ledger. |

The metadata table is single-table so that one `Query` on a partition returns a record and everything hanging off it: a run with its children, results and outputs, or a user with everything they own. The table has no secondary indexes. Every access pattern below is a `GetItem`, or a `Query` on `pk` with an optional `begins_with` on `sk`.

**Opening the model:** in NoSQL Workbench, choose *Data modeler → Import data model* and pick `nosql-workbench-model.json`. The metadata table has one **facet** per entity (Device, Artifact, ModuleVersion, …). Open a facet to see only that entity's rows, with readable key names, or use the *Visualizer* aggregate view to see the whole sample dataset.

## Key conventions

- **Prefixed ids.** Keys are `TYPE#id`, for example `DEVICE#dev-001`, `ARTIFACT#art-004` or `RUN#run-001`. The prefix says what kind of record the key points to.
- **Time-ordered ids.** Artifact and upload-batch ids are UUIDv7, so their link rows sort by creation time and `ScanIndexForward = false` lists newest first. The sample data uses short readable ids instead.
- **Base record.** Every entity's own record is `pk = TYPE#id`, `sk = METADATA`. The other rows in that partition are children or links.
- **Versions.** `VERSION#0001`, `VERSION#0002`, … are zero-padded so that they sort in order. Version numbers elsewhere (`moduleVersion`, `envVersion`, `latestVersion`) are plain numbers.
- **`entity`.** Every row has an `entity` attribute naming its kind (`device`, `run-child`, `user-artifact`, …). Use it to tell rows apart when a query returns a mixed partition.
- **Two-way links.** A relationship is written as two rows, one in each partition, so that it can be queried from either side. Both rows are written in the same `TransactWriteItems` call. The row in the `USER#` / `DEVICE#` / `BATCH#` partition repeats a few **immutable** display fields (`name`, `type`, `createdAt`). Anything that changes, such as `status`, is only stored on the base record: list endpoints query the link rows, then read the base records with `BatchGetItem`, so status is never stale.
- **Ownership.** Every device, artifact, upload batch, module, environment, run and session has `USER#{uid} / X#{id}` and `X#{id} / USER#{uid}` rows with `role = owner`. Their `entity` values are `user-x` / `x-user` (`user-device` / `device-user`, `user-artifact` / `artifact-user`, and likewise `batch`, `module`, `env`, `run`, `session`). `owner` is currently the only role. The ownership check is a single `GetItem(USER#{uid}, X#{id})`.
- **Money.** Costs, holds and limits are DynamoDB numbers (`N`, exact decimals; boto3 `Decimal`) in USD, so they can be added atomically and compared in conditions.
- **Timestamps.** ISO-8601 UTC strings.

## Entities

### Device: `DEVICE#{id}` / `METADATA`

A physical device under test.

| Attribute | Type | Meaning |
|---|---|---|
| `name` | S | Display name |
| `type` | S | Device category, e.g. `blood-pressure` |
| `status` | S | `active` |
| `reverseEngineeringStatus` | S | `not_started` / `in_progress` / `complete`. Set by the owner with `PATCH /devices/{id}` (`update-device`). Separate from `status`. Devices created before it existed have no attribute and read as `not_started`. Only stored here, not on the link rows; `GET /devices` reads it with `BatchGetItem`. |
| `dataPath` | S | S3 prefix for the device's files |
| `createdAt`, `updatedAt` | S | Timestamps |

### Artifact: `ARTIFACT#{id}` / `METADATA`

Any stored file: uploaded firmware, pcaps, logs and binaries, plus every file a run produces.

| Attribute | Type | Meaning |
|---|---|---|
| `name` | S | Display name (defaults to the file name) |
| `type` | S | What the file is: `firmware` / `pcap` / `log` / `binary` / `other`. A run's output uses the same types, so an output pcap matches `type = pcap` queries. |
| `origin` | S | `upload` (sent from the web app) / `run` (written by a run) |
| `version` | S | Firmware version; required when `type = firmware`, not allowed otherwise |
| `sha256` | S | Full-file SHA-256, declared by the uploader. Only a verified hash is trusted, e.g. as a run-result key. |
| `sizeBytes` | N | Size in bytes (up to 5 GiB) |
| `originalFilename` | S | Name as uploaded, including the folder path for folder uploads |
| `s3Bucket`, `s3Key` | S | Object location: `artifacts/{artifactId}/{attemptId}` |
| `attemptId` | S | Current upload attempt. Every complete and retry is conditional on it. |
| `uploadMode` | S | `single` (presigned POST, up to 25 MiB) / `multipart` |
| `uploadId`, `partSize`, `partCount` | S, N, N | Multipart only: the S3 upload id and part layout (parts of at least 16 MiB, at most 1000 parts) |
| `uploadBatchId` | S | Upload batch the file was sent in |
| `deviceIds` | SS | Linked devices (copy of the link rows, for display) |
| `status` | S | See lifecycle below |
| `reverseEngineeringStatus` | S | **Firmware only.** Reverse-engineering progress: `not_started` / `in_progress` / `complete`, separate from the upload `status`. Written as `not_started` whenever a firmware artifact is created (upload, run output, migration). Set by the owner with `PATCH /artifacts/{id}` (`artifacts-update`), which rejects other types. Firmware stored before it existed has no attribute and is returned as `not_started`; other types never have it and their API responses leave it out. Independent of the device's `reverseEngineeringStatus`. |
| `statusReason` | S | Why the upload failed |
| `statusUpdatedAt` | S | Time of the last status change |
| `tags` | SS | Free-form labels, used in run input queries |
| `derivedFromRun` | S | For `origin = run`: the run that produced the file |
| `derivedFromArtifacts` | SS | For `origin = run`: the input artifact ids |
| `migratedFromFirmwareId` | S | Set on records copied from the old `FIRMWARE#` rows |
| `createdBy`, `createdAt`, `updatedAt`, `uploadedAt` | S | Author and timestamps |

Lifecycle:
- **Single:** `pending` (upload URL issued) → `ready`. S3 checks the bytes against the declared SHA-256 as they are written, and complete confirms the stored checksum.
- **Multipart:** `pending` → `verifying` (parts assembled; S3 only checks SHA-256 per part) → `ready`, once `artifacts-verify` has streamed the object and checked the full SHA-256.
- Either can end in `failed`. A `pending` or `failed` upload can be retried, which starts a new `attemptId` and S3 key.
- The S3 object is tagged `upload-state=pending` until it is `ready`. A lifecycle rule deletes pending objects after 7 days, which removes superseded attempts and abandoned uploads.

Device links are **optional**, and an artifact can link to several devices (only devices the uploader owns):
- `DEVICE#{did} / ARTIFACT#{type}#{id}` (`device-artifact`): `name`, `type`. The type is in the sort key, so "this device's firmware" is a single `begins_with`.
- `ARTIFACT#{id} / DEVICE#{did}` (`artifact-device`): `name` of the device.

**Firmware version guard:** `DEVICE#{did} / FWVER#{version}` (`device-firmware-version`): `artifactId`, `version`. Written in the same transaction as the artifact, one per linked device, with `attribute_not_exists`, so a firmware version is unique per device.

### Upload batch: `BATCH#{id}` / `METADATA`

The files sent together in one upload from the web app. A run can use a batch as its input set.

| Attribute | Type | Meaning |
|---|---|---|
| `fileCount`, `totalBytes` | N | Files registered in the batch and their total size |
| `createdBy`, `createdAt`, `updatedAt` | S | Author and timestamps |

- Members: `BATCH#{bid} / ARTIFACT#{aid}` (`batch-artifact`): `name`, `type`.
- Ownership: `USER#{uid} / BATCH#{bid}` (`user-batch`) and `BATCH#{bid} / USER#{uid}` (`batch-user`).

### Module: `MODULE#{id}` / `METADATA`

A script the user uploads. Command-line tools reach a script through its environment (catalog tools) or an L3 Dockerfile; there is no separate "tool" module.

| | Meaning |
|---|---|
| **`runtime = cloud`** | Built into an image and run in bulk on AWS Batch |
| **`runtime = local`** | Stored and versioned only; runs on the user's machine. The cloud never builds or runs it. |

| Attribute | Type | Meaning |
|---|---|---|
| `name`, `description` | S | Display fields |
| `runtime` | S | `cloud` / `local` |
| `latestVersion` | N | Highest version number handed out |
| `latestReadyVersion` | N | Highest version that built successfully |
| `createdBy`, `createdAt`, `updatedAt` | S | Author and timestamps |

### Module version: `MODULE#{id}` / `VERSION#{n}`

`entity = module-version`.

| Attribute | Type | Cloud | Local | Meaning |
|---|---|---|---|---|
| `level` | S | ✓ | – | `L1` (`.py` with PEP 723), `L2` (`.zip` project), `L3` (`.zip` with Dockerfile) |
| `envId`, `envVersion`, `baseImage` | S, N, S | L1/L2 | – | Environment version the image is built `FROM` (default `platform-base`) |
| `command` | L | ✓ | – | What the launcher runs per work unit: the SDK driver for L1/L2, `platform.json`'s `command` for L3 |
| `sourceKey`, `sha256`, `sizeBytes`, `originalFilename` | S, S, N, S | ✓ | ✓ | The uploaded source (`scripts/{id}/{n}/{attempt}`) |
| `buildId` | S | ✓ | – | CodeBuild build id (links to the build log) |
| `imageUri` | S | ✓ | – | The built image, by digest (`repo@sha256:…`) |
| `jobDefinitionArn`, `heavyJobDefinitionArn` | S | ✓ | – | Batch job definitions for Fargate and, when enabled, EC2 |
| `freezeKey` | S | ✓ | – | S3 prefix of the `pip freeze` / `dpkg` lists |
| `status`, `statusReason`, `statusUpdatedAt` | S | ✓ | ✓ | See lifecycle below |
| `createdBy`, `createdAt` | S | ✓ | ✓ | Author and timestamp |

Lifecycle:
- **Cloud:** `pending` (upload URL issued) → `building` → `ready`. It can end in `rejected` (fails validation before the build, with the reason) or `build_failed`.
- **Local:** `pending` → `ready`.

### Environment: `ENV#{id}` / `METADATA`, and `ENV#{id}` / `VERSION#{n}`

A built container image with a set of tools. Scripts are built on top of it, and (step 3) sessions run on it. The base record (`entity = env`) has `name`, `description`, `base`, `latestVersion`, `latestReadyVersion`, `createdBy` and timestamps.

Two **platform environments** (`platform-base` and `platform-ghidra`) are published by the deploy-images workflow (`createdBy = platform`). They are listed under `PLATFORM / ENV#{id}` (`platform-env`), so every user can see them without an ownership row.

Each version (`entity = env-version`):

| Attribute | Type | Meaning |
|---|---|---|
| `baseImage` | S | Image this version is built `FROM` (a platform image or the parent version) |
| `catalogItems` | L | Catalog tools in the image, including those inherited from the parent |
| `parentVersion` / `basedOn` | N / S | The version it was built from |
| `packageMode` | S | `offline` (the only mode in v1) |
| `buildId`, `imageUri`, `freezeKey` | S | Same meaning as for module versions |
| `taskDefArn` | S | (Step 3) ECS task definition used to start sessions |
| `status`, `statusReason`, `statusUpdatedAt` | S | Same lifecycle as a cloud module version |
| `createdAt` | S | Timestamp |

### Run: `RUN#{id}` / `METADATA`

One cloud execution of a module version over a fixed set of input artifacts, run as an AWS Batch array job. The inputs are split into **work units**, one or more files each; the script runs once per unit.

| Attribute | Type | Meaning |
|---|---|---|
| `name` | S | Display name |
| `moduleId`, `moduleName`, `moduleVersion` | S, S, N | What is being run |
| `imageUri`, `jobDefinitionArn` | S | The image and job definition used |
| `inputs` | M | How the inputs were chosen (`batchId`, `deviceId`, `runId`, `artifactIds` count, or `type`/`tag`) |
| `mode`, `groupBy`, `chunkSize`, `unitsPerJob` | S, M, N, N | How files became units (`map` / `groupBy` / `chunk` / `all`) and units per job |
| `class`, `size`, `vcpu`, `memoryMiB`, `timeoutSec` | S, S, N, N, N | Capacity per job |
| `inputCount`, `unitCount`, `childCount` | N | Files, work units and Batch jobs |
| `maxCost`, `expectedCost`, `held` | N | Maximum (held against the budget), expected, and still held |
| `costProvisional`, `costActual` | N | From metering events / from the monthly true-up |
| `unitsSucceeded`, `unitsFailed`, `outputCount` | N | Progress counters, updated by the manifest service |
| `tokenHash` | S | SHA-256 of the per-run manifest token |
| `batchJobId` | S | The Batch (array) job |
| `cancelRequested`, `stopReason` | BOOL, S | Set by cancel, and by the watchdog when it stops the run |
| `status`, `statusReason`, `statusUpdatedAt` | S | See lifecycle below |
| `startedAt`, `endedAt`, `createdBy`, `createdAt`, `updatedAt` | S | Timestamps |

Lifecycle: `pending` → `queued` → `running` → `completed`, `failed`, `cancelled` (by the user) or `stopped` (by the watchdog: cost cap or budget). `completed` means every job ran; individual units can still have failed (`unitsFailed`).

Rows in the run's partition:
- `RUN#{id} / CHILD#{i:05}` (`run-child`): `units` (list of `{unitId, key, artifactIds}`), `status` (`queued` / `running` / `succeeded` / `failed`), `statusRank`, `attempts`, `logStreamName`, `startedAt`, `stoppedAt`, `statusReason`
- `RUN#{id} / RESULT#{unitId}` (`run-result`): `key`, `status` (`succeeded` / `failed`), `inputArtifactIds`, `outputArtifactIds`, `exitCode`, `error`. `unitId` is the SHA-256 of the unit's sorted input hashes, so identical units are only run once and a retried job skips finished units.
- `RUN#{id} / OUTCOUNT#{unitId}#{attempt}` (`run-output-count`): `files`, `bytes` registered so far, used to enforce the output caps
- `RUN#{id} / ARTIFACT#{aid}` (`run-artifact`) and `ARTIFACT#{aid} / RUN#{id}` (`artifact-run`): `relation` (`input` / `output`), so lineage can be followed both ways
- `RUN#{id} / DEVICE#{did}` (`run-device`) and `DEVICE#{did} / RUN#{id}` (`device-run`): when the inputs were chosen by device

Other run rows:
- `MODULE#{id} / RUN#{rid}` (`module-run`): `moduleVersion`, `status`, `class`, `size`, `childCount`, `unitCount`, `unitSeconds`. The run history per module; expected costs use seconds per unit from the last 20 runs.
- `ACTIVE#RUNS / RUN#{rid}` (`active-run`): `userId`. Written at start and deleted when the run settles; the watchdog reads only this partition.

Output artifacts are ordinary artifacts with `origin = run`, `derivedFromRun`, `derivedFromArtifacts` (the unit's inputs) and `runUnitId`, owned by the run's owner.

### Session: `SESSION#{id}` / `METADATA`

(Step 3.) An interactive JupyterLab session on Fargate. **Session** only ever means this; executions are runs.

| Attribute | Type | Meaning |
|---|---|---|
| `name` | S | Display name |
| `envId`, `envVersion` | S, N | Environment the session runs on |
| `packageMode` | S | Per-session override of the environment's mode |
| `taskArn`, `taskIp` | S | ECS task; the session proxy forwards traffic to `taskIp` |
| `tokenHash` | S | SHA-256 of the per-session manifest token |
| `status`, `statusReason`, `statusUpdatedAt` | S | `starting` → `running` → `stopping` → `stopped`, or `failed` |
| `startedAt`, `lastActivity`, `endedAt` | S | `lastActivity` drives the idle reaper |
| `cost` | N | Running cost total |
| `createdBy`, `createdAt`, `updatedAt` | S | Author and timestamps |

### Budget: `USER#{uid}` / `BUDGET`

Created with defaults (`DEFAULT_MONTHLY_LIMIT`, $25; Heavy off) the first time it's needed. Admins change it with `Platform/scripts/set_budget.py`.

| Attribute | Type | Meaning |
|---|---|---|
| `monthlyLimit` | N | Monthly spending limit (USD) |
| `period` | S | Month that `spentProvisional` belongs to (`2026-09`) |
| `spentProvisional` | N | Metered spend in `period` |
| `held` | N | Sum of the maximum costs of runs still going |
| `heavyEnabled` | BOOL | Whether the user can use the Heavy (EC2) class |
| `version` | N | Bumped by every write; holds are only written if it's unchanged since they were read |
| `updatedAt` | S | Timestamp |

A run starts only if `spentProvisional + held + maxCost <= monthlyLimit` (spend counts as 0 once `period` is a past month). The hold is written with `version = <read version>`, so two runs can't both claim the same remaining budget. Settlement and metering use atomic `ADD` (and bump `version`).

### Usage ledger: `USER#{uid}` / `USAGE#{period}#{source}#{resourceId}#{eventId}`

Append-only. `period` is the month the usage happened in, `source` is `batch`, `codebuild`, `ecs` (step 3) or `cur` (true-up), and `eventId` is the Batch job or CodeBuild build id. The key is deterministic and written with `attribute_not_exists(sk)`, so a redelivered event can't bill twice; the budget and run cost updates happen in the same transaction.

| Attribute | Type | Meaning |
|---|---|---|
| `kind` | S | `provisional` (from metering events) / `actual` (from the true-up) |
| `amount` | N | Cost in USD |
| `period`, `recordedAt` | S | Usage month and when it was recorded |
| `resource` | S | Human-readable description |
| `seconds` / `minutes` | N | Billed job seconds (all attempts, at least 60 each) / build minutes |
| `runId`, `jobId`, `buildId` | S | What was charged |
| `costTags` | M | Cost-allocation tags (`userId`, `runId`, …) |

## Relationships

```mermaid
erDiagram
    USER ||--o{ DEVICE : owns
    USER ||--o{ ARTIFACT : owns
    USER ||--o{ BATCH : owns
    BATCH |o--|{ ARTIFACT : "uploaded together"
    USER ||--o{ MODULE : owns
    USER ||--o{ ENV : owns
    USER ||--o{ RUN : owns
    USER ||--o{ SESSION : owns
    USER ||--|| BUDGET : has
    USER ||--o{ USAGE : "is charged"
    DEVICE }o--o{ ARTIFACT : "optional link"
    DEVICE }o--o{ RUN : "optional link"
    MODULE ||--|{ MODULE_VERSION : has
    ENV ||--|{ ENV_VERSION : has
    ENV_VERSION ||--o{ MODULE_VERSION : "built on (cloud only)"
    ENV_VERSION ||--o{ SESSION : "runs"
    MODULE_VERSION ||--o{ RUN : "executed by (cloud only)"
    RUN ||--|{ RUN_CHILD : "jobs (work units)"
    RUN ||--o{ RUN_RESULT : "one per work unit"
    RUN }o--o{ ARTIFACT : "input / output (links both ways)"
```

- Every `owns` edge is a pair of ownership-link rows.
- `DEVICE` edges are optional. An artifact or run can have none, one or several.
- Local modules have versions, but nothing is built on them and no run executes them.

## Access patterns

| Need | Operation |
|---|---|
| User's devices / artifacts / batches / modules / envs / runs / sessions | `Query pk = USER#{uid}, sk begins_with DEVICE#` (or `ARTIFACT#`, `BATCH#`, `MODULE#`, `ENV#`, `RUN#`, `SESSION#`) |
| Ownership check before any read or write | `GetItem pk = USER#{uid}, sk = X#{id}` |
| Owners of a resource | `Query pk = X#{id}, sk begins_with USER#` |
| A device's firmware | `Query pk = DEVICE#{did}, sk begins_with ARTIFACT#firmware#` |
| Is this firmware version taken on the device? | `GetItem pk = DEVICE#{did}, sk = FWVER#{version}` |
| Files in an upload batch | `Query pk = BATCH#{bid}, sk begins_with ARTIFACT#` |
| All of a device's artifacts / runs | `Query pk = DEVICE#{did}, sk begins_with ARTIFACT#` / `RUN#` |
| Devices an artifact or run is linked to | `Query pk = ARTIFACT#{id}` (or `RUN#{id}`), `sk begins_with DEVICE#` |
| Artifact details | `GetItem pk = ARTIFACT#{id}, sk = METADATA` (many at once: `BatchGetItem`) |
| Module and all its versions | `Query pk = MODULE#{id}`. Rows sort as `METADATA`, `RUN#…`, `VERSION#…`, so filter on `entity`, or use two queries (`sk = METADATA`, `sk begins_with VERSION#`) |
| Newest ready module version | `Query pk = MODULE#{id}, sk begins_with VERSION#`, `ScanIndexForward = false`, first `status = ready` |
| Module run history (for estimates) | `Query pk = MODULE#{id}, sk begins_with RUN#`, newest 20 |
| Environment versions | `Query pk = ENV#{id}, sk begins_with VERSION#` |
| Platform environments (visible to everyone) | `Query pk = PLATFORM, sk begins_with ENV#` |
| Everything about a run | `Query pk = RUN#{id}` |
| A run's jobs / outputs | `Query pk = RUN#{id}, sk begins_with CHILD#` / `ARTIFACT#` (filter `relation = output`) |
| Which runs used or produced this artifact | `Query pk = ARTIFACT#{aid}, sk begins_with RUN#` |
| Has this work unit already been done? | `GetItem pk = RUN#{id}, sk = RESULT#{unitId}` (many at once: `BatchGetItem`) |
| Runs in progress (watchdog) | `Query pk = ACTIVE#RUNS` |
| Session for the proxy | `GetItem pk = SESSION#{id}, sk = METADATA` |
| Budget check / hold | `GetItem` then `UpdateItem pk = USER#{uid}, sk = BUDGET` conditional on `version` |
| Usage for a month | `Query pk = USER#{uid}, sk begins_with USAGE#2026-09#` |

## Status tracking

Each status-bearing row stores its **current** status (`status`, `statusReason`, `statusUpdatedAt`) in DynamoDB. The UI reads status from these rows only, and never calls CodeBuild, Batch or ECS from the browser path.
- **Writers:** the event Lambdas (`builds-events`, `runs-events`, `usage-meter`, and the session Lambdas in step 3) triggered by EventBridge state-change events, plus `runs-manifest` for work-unit results. They use conditional updates, so an out-of-order or repeated event can't move a status backwards or apply twice.
- **What isn't stored:** build logs, job logs and package lists. These stay in CloudWatch Logs and S3, and the row only points to them (`buildId`, `logStreamName`, `freezeKey`). The UI fetches them when a user opens them.
- **No history table:** status history isn't kept. `statusUpdatedAt` is enough to spot stuck work, and the usage ledger records what was billed.

## Migration and future work

- **Firmware:** the web app now uploads firmware as `ARTIFACT#` records (`type = firmware`) with device links and a `FWVER#` guard. The old firmware Lambdas (`presign-firmware`, `complete-firmware`, `list-firmware`) and their `DEVICE#{did} / FIRMWARE#{version}` rows are still deployed but no longer used by the UI. [`Platform/scripts/migrate_firmware_to_artifacts.py`](../scripts/migrate_firmware_to_artifacts.py) copies the old rows into artifacts (dry run by default, `--apply` to write; safe to re-run). The S3 objects stay where they are. Once it has run, the old Lambdas and routes can be removed. `FIRMWARE#` rows are deliberately left out of the model.
- **Old model:** `OUTPUT#`, `MODULE# / SCRIPT|TOOL` and the run-style `SESSION#` rows from the April model have been replaced by the entities above. Modules no longer have a `kind`: tools come from environments or L3 Dockerfiles.
- **Groups and sharing:** only `role = owner` is used today. A later user-groups system can add a `GROUP#{gid}` principal with the same two-way link shape (`GROUP#/X#` and `X#/GROUP#`) and more roles, without changing existing rows.
