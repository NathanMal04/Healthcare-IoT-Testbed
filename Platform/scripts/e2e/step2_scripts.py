#!/usr/bin/env python3
"""End-to-end checks for step 2 (scripts, environments and runs) against dev.

Standard library only. Same setup as step1_artifacts.py:

  API_URL=https://xxxx.execute-api.us-east-2.amazonaws.com/dev ID_TOKEN=eyJ... \\
  python3 Platform/scripts/e2e/step2_scripts.py [--with-l3]

What it does:
  1. Uploads scripts that must be rejected (syntax error, URL dependency, stdlib clash).
  2. Uploads an L1 "probe" script and waits for its build.
  3. Uploads three log+pcap pairs and one lone log as an upload batch.
  4. Estimates and starts a groupBy (file name, require log+pcap) run and waits for it.
  5. Reads the probe's reports: inputs arrived, tshark is present, no internet, no AWS credentials.
  6. Checks lineage, the run page data, usage rows, and that an over-budget run is refused.
  7. With --with-l3: builds an L3 zip (own Dockerfile) and runs it over one file.

It creates real (small) builds and jobs, so it costs a few cents.
"""
import argparse
import importlib.util
import io
import json
import os
import sys
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("step1", HERE / "step1_artifacts.py")
step1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(step1)
api, check, failures, post_form, file_spec = step1.api, step1.check, step1.failures, step1.post_form, step1.file_spec

PROBE = '''\
import json, os, shutil, socket, urllib.request

def reachable(host, port):
    try:
        socket.create_connection((host, port), timeout=5).close()
        return True
    except OSError:
        return False

def run(ctx):
    ctx.output("probe.json").write_text(json.dumps({
        "key": ctx.group_key,
        "inputs": sorted((f.type, f.size_bytes, f.path.exists()) for f in ctx.inputs),
        "tshark": shutil.which("tshark") is not None,
        "internet": reachable("example.com", 443),
        "credentials_endpoint": reachable("169.254.170.2", 80),
        "aws_env": sorted(k for k in os.environ if k.startswith("AWS_") and "BATCH" not in k and k != "AWS_REGION" and k != "AWS_DEFAULT_REGION"),
    }))
'''


def upload_version(module_id, name, content, level, env_id=None):
    body = {"level": level, "originalFilename": name, "sizeBytes": len(content),
            "sha256": __import__("hashlib").sha256(content).hexdigest()}
    if env_id:
        body["envId"] = env_id
    status, created = api("POST", f"/modules/{module_id}/versions", body)
    if status != 201:
        raise RuntimeError(f"create version failed: {status} {created}")
    post_form(created["upload"], content)
    status, done = api("POST", f"/modules/{module_id}/versions/{created['version']['version']}/complete")
    return done.get("version", done)


def wait_version(module_id, version, timeout=1800):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, body = api("GET", f"/modules/{module_id}")
        v = next(v for v in body["versions"] if v["version"] == version)
        if v["status"] not in ("pending", "building"):
            return v
        time.sleep(15)
    return None


def wait_run(run_id, timeout=2400):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, body = api("GET", f"/runs/{run_id}")
        if body["run"]["status"] in ("completed", "failed", "cancelled", "stopped"):
            return body
        time.sleep(15)
    return None


def zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-l3", action="store_true")
    args = parser.parse_args()
    if not step1.API_URL or not step1.ID_TOKEN:
        sys.exit("Set API_URL and ID_TOKEN (see step1_artifacts.py)")

    _, envs = api("GET", "/environments")
    base = next((e for e in envs.get("environments", []) if e["envId"] == "platform-base"), None)
    check(base is not None and base.get("latestReadyVersion"), "platform-base environment is published")

    status, module = api("POST", "/modules", {"name": f"e2e probe {uuid.uuid4().hex[:6]}", "runtime": "cloud"})
    module_id = module["module"]["moduleId"]

    for name, content, level, why in [
        ("bad.py", b"def run(ctx):\n  return (\n", "L1", "syntax error"),
        ("dep.py", b'# /// script\n# dependencies = ["x @ https://example.com/x.whl"]\n# ///\ndef run(ctx): pass\n', "L1", "URL dependency"),
        ("clash.zip", zip_bytes({"main.py": "def run(ctx): pass", "json.py": ""}), "L2", "stdlib name clash"),
    ]:
        v = upload_version(module_id, name, content, level)
        check(v.get("status") == "rejected", f"rejected: {why} ({v.get('statusReason')})")

    v = upload_version(module_id, "probe.py", PROBE.encode(), "L1", "platform-base")
    check(v.get("status") == "building", "probe script build started")
    v = wait_version(module_id, v["version"])
    check(v is not None and v["status"] == "ready", f"probe script built ({v and v.get('statusReason')})")
    if not v or v["status"] != "ready":
        return finish()

    files = []
    for i in range(3):
        files += [(f"e2e-pairs/test-{i:03d}.log", "log", f"log {i}\n".encode()),
                  (f"e2e-pairs/test-{i:03d}.pcap", "pcap", f"not really a pcap {i}".encode())]
    files.append(("e2e-pairs/test-099.log", "log", b"lonely log"))
    presigned = step1.presign([file_spec(data, path, typ) for path, typ, data in files])
    batch_id = presigned["uploadBatchId"]
    for (path, typ, data), result in zip(files, presigned["results"]):
        post_form(result["upload"], data)
        step1.complete(result["artifactId"], result["attemptId"])

    request = {"moduleId": module_id, "inputs": {"batchId": batch_id}, "mode": "groupBy",
               "groupBy": {"by": "stem", "requireTypes": ["log", "pcap"]},
               "class": "standard", "size": "S", "timeoutMinutes": 10, "name": "e2e probe run"}
    _, est = api("POST", "/runs/estimate", request)
    check(est.get("unitCount") == 3 and est.get("incompleteCount") == 1, f"estimate: 3 pairs, 1 incomplete ({est})")

    status, started = api("POST", "/runs", request)
    check(status == 201, f"run started ({started})")
    if status != 201:
        return finish()
    run_id = started["run"]["runId"]
    detail = wait_run(run_id)
    check(detail is not None and detail["run"]["status"] == "completed", f"run completed ({detail and detail['run']})")
    if detail:
        run = detail["run"]
        check(run["unitsSucceeded"] == 3 and run["unitsFailed"] == 0 and run["outputCount"] == 3, "3 units succeeded with 3 outputs")

    _, outputs = api("GET", "/artifacts", query={"runId": run_id, "limit": 100})
    reports = []
    for artifact in outputs.get("artifacts", []):
        _, dl = api("GET", f"/artifacts/{artifact['artifactId']}/download")
        reports.append(json.loads(urllib.request.urlopen(dl["url"]).read()))
    check(len(reports) == 3, "3 probe reports downloaded")
    check(all(len(r["inputs"]) == 2 and all(exists for _, _, exists in r["inputs"]) for r in reports), "each unit got its log and pcap")
    check(all(r["tshark"] for r in reports), "tshark is available in platform-base")
    check(not any(r["internet"] for r in reports), "no internet from inside the job")
    check(not any(r["credentials_endpoint"] for r in reports) and not any(r["aws_env"] for r in reports),
          "no AWS credentials inside the job")

    time.sleep(30)  # metering events arrive asynchronously
    _, usage = api("GET", "/usage")
    check(any(e.get("runId") == run_id for e in usage.get("entries", [])), "usage ledger has rows for the run")

    big = dict(request, mode="map", size="XL", timeoutMinutes=360, unitsPerJob=1)
    _, est = api("POST", "/runs/estimate", big)
    if est.get("maxCost", 0) > est.get("budget", {}).get("available", 0):
        status, _ = api("POST", "/runs", big)
        check(status == 409, "a run over the remaining budget is refused")
    else:
        print("skip  budget refusal (budget large enough for the big run)")

    if args.with_l3:
        l3 = zip_bytes({
            "Dockerfile": "FROM alpine:3.20\nRUN apk add --no-cache coreutils\n",
            "platform.json": json.dumps({"command": ["/bin/sh", "-c", 'sha256sum "$PLATFORM_INPUT" > "$PLATFORM_OUTPUT_DIR/sum.txt"']}),
        })
        _, m3 = api("POST", "/modules", {"name": f"e2e l3 {uuid.uuid4().hex[:6]}", "runtime": "cloud"})
        v = upload_version(m3["module"]["moduleId"], "l3.zip", l3, "L3")
        v = wait_version(m3["module"]["moduleId"], v["version"])
        check(v is not None and v["status"] == "ready", "L3 image built")
        if v and v["status"] == "ready":
            first = presigned["results"][0]["artifactId"]
            status, started = api("POST", "/runs", {"moduleId": m3["module"]["moduleId"], "inputs": {"artifactIds": [first]},
                                                    "mode": "map", "class": "economy", "size": "S", "timeoutMinutes": 10})
            detail = wait_run(started["run"]["runId"]) if status == 201 else None
            check(detail is not None and detail["run"]["outputCount"] == 1, "L3 run produced its output")

    finish()


def finish():
    print()
    print("ALL PASSED" if not failures else f"{len(failures)} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
