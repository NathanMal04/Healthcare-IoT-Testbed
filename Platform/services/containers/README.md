# Script containers

Everything that runs inside a run job, and the kit that builds those images.

```
containers/
  base/Dockerfile      analysis-base: Python 3.12 + tshark, binwalk, scapy, dpkt, pyshark, lief,
                       pyelftools, capstone, yara-python, pandas, unblob; plus /opt/platform
  ghidra/Dockerfile    platform-ghidra: analysis-base + headless Ghidra 11.1
  launcher/            the job entrypoint (Go, static binary)
  sdk/platform_sdk/    Python helpers: run(ctx) driver, local runner
  buildkit/            what CodeBuild runs: build.py, buildspec.yml, catalog.json
  notebook/            the JupyterLab layer for notebook sessions (session.py, platform_notebook.py)
```

The base and Ghidra images are built by `.github/workflows/deploy-images.yml` and recorded as the
`platform-base` and `platform-ghidra` environments. Environment and script images are built by CodeBuild
from `buildkit/` (see `Platform/infra/envs/dev/builds.tf`).

## Writing a script

A job has **no internet and no AWS credentials**. Its inputs are already on local disk, and anything it
writes to its output folder becomes a new artifact linked back to its inputs.

The platform runs the script once per **work unit**: one file (`map` mode), or a group of files that belong
together (`groupBy`, `chunk` or `all`).

### L1: a single `.py` file

```python
# /// script
# dependencies = ["rich>=13"]
# ///
import json
import subprocess

def run(ctx):
    pcap = ctx.first(type="pcap")          # or ctx.input for single-file units
    log = ctx.first(type="log")
    summary = subprocess.run(["tshark", "-r", str(pcap), "-q", "-z", "io,phs"],
                             capture_output=True, text=True, check=True).stdout
    ctx.output("report.json").write_text(json.dumps({
        "test": ctx.group_key,
        "protocols": summary,
        "log_lines": len(log.read_text().splitlines()) if log else 0,
    }))
```

- **Dependencies** go in the PEP 723 block. They're installed from wheels only (`--only-binary=:all:`), and only name and version specifiers are accepted (no URLs, paths or pip options).
- **System tools** come from the script's environment: the analysis base, or one you build on the Environments page from the tool catalog.

### L2: a `.zip` project

```
main.py            def run(ctx): ...
helpers/…          imported normally from main.py
requirements.txt   optional, same rules as above
platform.json      optional: {"entrypoint": "other.py"}
```

- **Naming:** files and folders at the top level must not share a name with a standard library module (`json.py`, `logging/`, …).
- **Limits:** at most 2000 files and 200 MB unpacked.

### L3: a `.zip` with your own Dockerfile

```
Dockerfile         any base image (Linux, amd64); install whatever you need
platform.json      {"command": ["/usr/local/bin/analyze", "--json"]}
…                  anything your Dockerfile COPYs
```

The platform adds the launcher on top of your image and runs `command` once per work unit, passing:

| Variable | Meaning |
|---|---|
| `PLATFORM_INPUT` | Path of the input file, when the unit has exactly one |
| `PLATFORM_INPUTS_DIR` | Folder with all of the unit's inputs (`<artifactId>/<name>`) |
| `PLATFORM_MANIFEST` | JSON file describing the unit: `key` and `inputs` (`path`, `name`, `type`, `sha256`, `sizeBytes`, `tags`) |
| `PLATFORM_OUTPUT_DIR` | Write results here; subfolders are kept |
| `PLATFORM_GROUP_KEY` | The unit's group key (file name, folder, …) |

- **Build steps** can use the internet, but they can't reach the build's AWS credentials.
- **Running:** the image then runs with no network at all.
- **Python:** if your image has Python 3, `python3 -m platform_sdk.driver /app/main.py` gives you the same `run(ctx)` interface as L1/L2 (the SDK is on `PYTHONPATH`).

### `ctx`

| | |
|---|---|
| `ctx.input` | `Path` of the only input (raises for grouped units) |
| `ctx.inputs` | All inputs: `path`, `artifact_id`, `name`, `type`, `sha256`, `size_bytes`, `tags`, `original_filename` |
| `ctx.first(type=None)` | `Path` of the first input (of that type), or `None` |
| `ctx.by_type("log")` | All inputs of a type |
| `ctx.group_key` | The unit's key |
| `ctx.output_dir` | Output folder |
| `ctx.output("a/b.json")` | A path under the output folder (parents created) |

Raising an exception (or exiting non-zero) fails just that work unit. Its error and the last lines of stderr are
shown on the run page, and the other units carry on.

### Trying a script locally

```bash
PYTHONPATH=Platform/services/containers/sdk python3 -m platform_sdk.run_local my_script.py test-017.log test-017.pcap --group test-017
PYTHONPATH=Platform/services/containers/sdk python3 -m platform_sdk.run_local my_script.py *.pcap --each
```

Outputs go to `./outputs/<unit>/`.

## Limits

| | |
|---|---|
| Script source | 50 MB |
| Files per run | 2000 |
| Timeout per job | 1 to 360 minutes (default 30) |
| Outputs per work unit | 1000 files, 20 GiB in total, 5 GiB per file; empty files are not allowed |
| Job disk | 50 GiB |

## How a job runs

1. **Manifest:** the launcher sends `POST $MANIFEST_URL/manifest` with the run token. It gets this job's work units, with a short-lived download link for each input.
2. **Per unit:**
   1. It downloads the inputs and checks their SHA-256.
   2. It runs `PLATFORM_COMMAND`.
   3. It registers the outputs (`/outputs/presign`) and uploads them straight to S3.
   4. It records the unit's result (`/outputs/complete`).
3. **Retries:** units that already have a result are skipped, so a retried job (after a Spot interruption, say) only does what's left.

The manifest service is `Platform/services/lambdas/runs-manifest`. It's a private API that's only reachable
from inside the run VPC.

## Notebook sessions

The Notebooks page opens an environment in JupyterLab with the files you choose. Sessions follow the same
rules as jobs: no internet, no AWS credentials, files only through the manifest service.

- **Files:** what you chose is in `/work/inputs`. `from platform_notebook import context; ctx = context()` gives
  you the same `ctx` as a script's `run(ctx)`.
- **Saved:** only `/work/notebooks`. It's saved every 10 minutes and when the session stops, and restored at the
  next start. There's one folder per user, shared by your sessions: if two are open, the last save wins. At most 2 GiB.
- **Stopping:** after 30 minutes with no browser tab open, at the session's time limit, by its Stop button, or
  when your monthly budget runs out.
- **Packages:** `pip install` fails at once (`PIP_NO_INDEX=1`). To add tools, build a new environment version and
  open that.
- **Save as script:** turns a notebook into an L1 script on the same environment. The `context()` lines are dropped,
  the code is wrapped in `run(ctx)` (unless the notebook defines it already), and `%`/`!` lines are commented out.

How it's put together:
- **Image:** `notebook/Dockerfile` builds a venv at `/opt/notebook` (JupyterLab, ipykernel) with
  `--system-site-packages`. A session task's first container copies it into a shared volume, mounted read-only
  into the environment's container, which runs `session.py`. So every environment version opens without a rebuild.
  This relies on environments being `python:3.12-slim-bookworm` based, which all platform-derived ones are.
- **Reaching it:** CloudFront sends `vzoniq.com/s/*` through a VPC origin to an internal load balancer. Each session
  has a target group and a `/s/{sessionId}/*` rule, and JupyterLab requires the session's token, which only its
  owner gets.

## Costs and the on-demand network

Jobs and sessions reach AWS only through VPC endpoints (ECR, CloudWatch Logs, the manifest API, and for Heavy the
ECS ones). Those cost about $0.01 an hour each, so they exist **only while there is work**: the `network-controller`
Lambda creates them when a run or session starts and deletes them `network_idle_minutes` (default 120) after the last
one finishes. While they're down, the Batch compute environments are disabled, and jobs wait in `RUNNABLE`.

- **Starting:** the first run or session after a quiet period waits about 2–3 minutes for the network.
- **Idle window:** set `network_idle_minutes` in `Platform/infra/envs/dev/variables.tf` (or the Lambda's
  `IDLE_MINUTES`). Each extra hour up costs about $0.04, or $0.07 with Heavy.
- **Always on:** only the notebook load balancer (about $17 a month) costs money when nothing runs.

