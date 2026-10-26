"""Entry point of a notebook session's workbench container.

Runs inside the environment's image, with this notebook layer mounted
read-only at /opt/notebook. It:

1. asks the manifest service (the private API) for the session's files, with
   the per-session token: presigned links for the chosen artifacts and for
   the user's saved notebooks;
2. downloads the inputs into /work/inputs (checking each SHA-256) and
   restores /work/notebooks;
3. runs JupyterLab on port 8888 under /s/{sessionId}/, reachable only from
   the load balancer, behind the session's token;
4. saves /work/notebooks every SAVE_INTERVAL seconds, and once more when
   JupyterLab shuts itself down after IDLE_SECONDS without activity, when the
   session reaches MAX_SECONDS, and when ECS stops the task (SIGTERM).

Standard library only, so the environment's own packages are left alone.
"""
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

WORK = Path("/work")
INPUTS = WORK / "inputs"
NOTEBOOKS = WORK / "notebooks"
OUTPUTS = WORK / "outputs"
MANIFEST_FILE = WORK / ".platform" / "manifest.json"
PORT = 8888

SESSION_ID = os.environ["SESSION_ID"]
# Kept out of the environment JupyterLab and its kernels inherit.
SESSION_TOKEN = os.environ.pop("SESSION_TOKEN")
MANIFEST_URL = os.environ["MANIFEST_URL"].rstrip("/")
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "7200"))
IDLE_SECONDS = int(os.environ.get("IDLE_SECONDS", "1800"))
SAVE_INTERVAL = int(os.environ.get("SAVE_INTERVAL", "600"))

stop_requested = False
last_saved = None


def log(message, **fields):
    print(json.dumps({"msg": message, **fields}), flush=True)


def main():
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    manifest = call("/session/manifest")
    max_home = int(manifest.get("limits", {}).get("maxHomeBytes", 2 * 1024 ** 3))
    NOTEBOOKS.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    home = manifest.get("home") or {}
    if home.get("url"):
        try:
            restore(home["url"])
        except Exception as e:  # a broken archive mustn't stop the session
            log("restore_failed", error=str(e))
    stage(manifest.get("inputs") or [])
    write_welcome()

    global last_saved
    last_saved = fingerprint()
    jupyter = start_jupyter()
    started = time.monotonic()
    next_save = started + SAVE_INTERVAL
    reason = "stopped"
    while True:
        if stop_requested:
            break
        if jupyter.poll() is not None:
            reason = "idle" if jupyter.returncode == 0 else f"jupyter exited ({jupyter.returncode})"
            break
        if time.monotonic() - started >= MAX_SECONDS:
            reason = "time limit"
            break
        if time.monotonic() >= next_save:
            save(max_home)
            next_save = time.monotonic() + SAVE_INTERVAL
        time.sleep(2)

    if jupyter.poll() is None:
        jupyter.terminate()
        try:
            jupyter.wait(timeout=20)
        except subprocess.TimeoutExpired:
            jupyter.kill()
    save(max_home)
    log("session_exit", reason=reason)
    # Non-zero only when JupyterLab itself failed, so the session shows as failed.
    return 1 if reason.startswith("jupyter exited") else 0


def _on_signal(signum, frame):
    global stop_requested
    stop_requested = True


# --- Manifest service ------------------------------------------------------------------

def call(path, body=None):
    data = json.dumps({"sessionId": SESSION_ID, **(body or {})}).encode()
    error = None
    for attempt in range(6):
        request = urllib.request.Request(MANIFEST_URL + path, data=data, method="POST", headers={
            "Content-Type": "application/json", "X-Session-Token": SESSION_TOKEN})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise RuntimeError(f"{path}: HTTP {e.code} {e.read()[:300]!r}")
            error = e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            error = e
        time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"{path}: {error}")


# --- Inputs ------------------------------------------------------------------------------

def stage(inputs):
    INPUTS.mkdir(parents=True, exist_ok=True)
    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    used, entries = set(), []
    for item in inputs:
        name = safe_name(item.get("name") or item.get("originalFilename") or item["artifactId"])
        if name in used:
            stem, dot, ext = name.rpartition(".")
            name = f"{stem}-{item['artifactId'][:8]}.{ext}" if dot and stem else f"{name}-{item['artifactId'][:8]}"
        used.add(name)
        path = INPUTS / name
        try:
            download(item["url"], path, item.get("sha256"))
        except Exception as e:
            log("input_failed", artifactId=item["artifactId"], error=str(e))
            continue
        entries.append({k: item.get(k) for k in ("artifactId", "name", "type", "sha256", "sizeBytes", "tags",
                                                 "originalFilename")} | {"path": str(path)})
    MANIFEST_FILE.write_text(json.dumps({"key": "notebook", "inputs": entries}, indent=2))
    log("inputs_staged", count=len(entries), requested=len(inputs))


def safe_name(name):
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(c if c.isalnum() or c in "._- " else "_" for c in name).strip().lstrip(".")
    return cleaned[:200] or "file"


def download(url, dest, sha256=None):
    digest = hashlib.sha256()
    partial = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if sha256 and digest.hexdigest() != sha256:
        partial.unlink()
        raise RuntimeError("SHA-256 mismatch")
    partial.rename(dest)


# --- Saved notebooks ---------------------------------------------------------------------

def restore(url):
    with tempfile.TemporaryFile(dir="/tmp") as archive:
        with urllib.request.urlopen(url, timeout=300) as response:
            shutil.copyfileobj(response, archive)
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode="r:gz") as tar:
            tar.extractall(NOTEBOOKS, filter="data")
    log("notebooks_restored")


def fingerprint():
    digest = hashlib.sha256()
    for path in sorted(NOTEBOOKS.rglob("*")):
        try:
            stat = path.lstat()
        except FileNotFoundError:
            continue
        digest.update(f"{path.relative_to(NOTEBOOKS)}\0{stat.st_size}\0{stat.st_mtime_ns}\n".encode())
    return digest.hexdigest()


def save(max_bytes):
    """Uploads /work/notebooks if it changed since the last save. Never
    raises: a failed save is retried at the next interval."""
    global last_saved
    try:
        current = fingerprint()
        if current == last_saved:
            return
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", dir="/tmp") as archive:
            with tarfile.open(archive.name, mode="w:gz") as tar:
                tar.add(NOTEBOOKS, arcname=".")
            size = os.path.getsize(archive.name)
            if size > max_bytes:
                log("notebooks_too_large", bytes=size, limit=max_bytes)
                return
            upload = call("/session/home")["upload"]
            post_file(upload["url"], upload["fields"], archive.name)
        last_saved = current
        log("notebooks_saved", bytes=size)
    except Exception as e:
        log("save_failed", error=str(e))


def post_file(url, fields, path):
    """A presigned POST, streamed from disk (the archive can be large)."""
    boundary = uuid.uuid4().hex
    head = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ) + (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="notebooks.tar.gz"\r\n'
         f"Content-Type: application/gzip\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()

    def body():
        yield head
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                yield chunk
        yield tail

    request = urllib.request.Request(url, data=body(), method="POST", headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(head) + os.path.getsize(path) + len(tail)),
    })
    with urllib.request.urlopen(request, timeout=900) as response:
        response.read()


# --- JupyterLab --------------------------------------------------------------------------

def start_jupyter():
    env = dict(os.environ, SHELL="/bin/bash")
    base_url = f"/s/{SESSION_ID}/"
    args = [
        sys.executable, "-m", "jupyterlab",
        "--no-browser", "--allow-root", "--ip=0.0.0.0", f"--port={PORT}",
        f"--ServerApp.base_url={base_url}",
        f"--ServerApp.root_dir={WORK}",
        "--ServerApp.trust_xheaders=True",
        # The token comes from JUPYTER_TOKEN; never offer a password login.
        "--PasswordIdentityProvider.allow_password_change=False",
        f"--ServerApp.shutdown_no_activity_timeout={IDLE_SECONDS}",
        f"--MappingKernelManager.cull_idle_timeout={IDLE_SECONDS}",
        "--MappingKernelManager.cull_interval=300",
        f"--TerminalManager.cull_inactive_timeout={IDLE_SECONDS}",
        "--TerminalManager.cull_interval=300",
        # Keeps WebSockets alive through CloudFront and the load balancer.
        '--ServerApp.tornado_settings={"websocket_ping_interval": 30}',
        "--LabApp.check_for_updates_class=jupyterlab.NeverCheckForUpdate",
    ]
    log("jupyter_starting", baseUrl=base_url)
    return subprocess.Popen(args, cwd=WORK, env=env)


def write_welcome():
    path = NOTEBOOKS / "Welcome.ipynb"
    if path.exists():
        return

    def md(text):
        return {"cell_type": "markdown", "metadata": {}, "source": text}

    def code(text):
        return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text}

    notebook = {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        "cells": [
            md("# Notebook session\n\n"
               "- The files you chose are in `/work/inputs`.\n"
               "- Only `/work/notebooks` (this folder) is kept between sessions. It is saved every 10 minutes "
               "and when the session stops.\n"
               "- There is no internet, so `pip install` doesn't work. To add tools, build a new version of "
               "the environment on the Environments page.\n"
               "- The session stops after 30 minutes with no browser tab open, or at its time limit.\n\n"
               "`context()` gives you the same `ctx` a script's `run(ctx)` gets. **Save as script** on the "
               "notebook page turns a notebook into a script: the `context()` lines are dropped and the rest "
               "is wrapped in `run(ctx)`, so it can run over many files."),
            code("from platform_notebook import context\n\n"
                 "ctx = context()  # or context(\"name-of-one-file\")\n"
                 "[(f.name, f.type, f.size_bytes) for f in ctx.inputs]"),
            code("first = ctx.inputs[0] if ctx.inputs else None\n"
                 "first.read_bytes()[:64] if first else \"No files staged\""),
        ],
    }
    path.write_text(json.dumps(notebook, indent=1))


if __name__ == "__main__":
    sys.exit(main())
