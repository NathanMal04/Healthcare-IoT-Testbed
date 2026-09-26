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
