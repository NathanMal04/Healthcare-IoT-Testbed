#!/usr/bin/env python3
"""parse_firmware.py — SSH / HTTP firmware retrieval with JSON telemetry.

Bugs fixed vs. the original:
  * SSH session is now always closed (try/finally + cleanup hook).
  * PTY-enabled exec_command (which merged stderr into stdout) is gone.
  * HTTP filename extraction uses urlparse().path so query strings don't
    leak into filenames.
  * Required CLI args are validated up-front for the chosen method.
"""
import argparse
import sys
from pathlib import Path
from urllib.parse import urlparse

from _re_common import (
    EXIT_TOOL_ERROR, EXIT_VALIDATION, add_common_args, check_deps, fail,
    install_signals, log, merge_json_args, progress, register_cleanup,
    result, write_output,
)

DEPS = {
    "paramiko": {"type": "py", "required": True,
                 "hint": "pip install paramiko"},
    "requests": {"type": "py", "required": True,
                 "hint": "pip install requests"},
}


def _ssh_pull(host, user, password, out_dir, cmd, get_path):
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    register_cleanup(client.close)

    log("info", f"Connecting to {user}@{host}")
    client.connect(hostname=host, username=user, password=password, timeout=15)

    artifacts = {}
    if cmd:
        progress(30, "Running remote command")
        _, stdout, stderr = client.exec_command(cmd)
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        artifacts["remote_command_stdout"] = out
        if err:
            artifacts["remote_command_stderr"] = err
            log("warning", f"stderr: {err[:200]}")

    if get_path:
        progress(60, f"Downloading {get_path}")
        sftp = client.open_sftp()
        register_cleanup(sftp.close)
        local = Path(out_dir) / Path(get_path).name
        sftp.get(get_path, str(local))
        artifacts["downloaded_file"] = str(local)
        log("info", f"Downloaded -> {local}")

    client.close()
    return artifacts


def _http_pull(url: str, out_dir: str) -> dict:
    import requests

    progress(10, "Starting HTTP download")
    session = requests.Session()
    register_cleanup(session.close)
    r = session.get(url, stream=True, timeout=60)
    r.raise_for_status()

    parsed = urlparse(url)
    filename = Path(parsed.path).name or "firmware.bin"
    local = Path(out_dir) / filename

    total = int(r.headers.get("content-length", 0))
    written = 0
    with open(local, "wb") as fh:
        for chunk in r.iter_content(65536):
            if not chunk:
                continue
            fh.write(chunk)
            written += len(chunk)
            if total:
                progress(min(99, int(written * 100 / total)), "Downloading")

    return {"downloaded_file": str(local), "bytes": written}


def main() -> None:
    p = argparse.ArgumentParser(description="Retrieve firmware over SSH/HTTP")
    p.add_argument("--method", choices=["ssh", "http"], default="ssh")
    p.add_argument("--host")
    p.add_argument("--user")
    p.add_argument("--pass", dest="password")
    p.add_argument("--out", default="./firmware_dumps")
    p.add_argument("--url")
    p.add_argument("--cmd", help='Remote command, e.g. "dd if=/dev/mtd0 of=/tmp/fw"')
    p.add_argument("--get", help="Remote file to SCP")
    add_common_args(p)
    args = merge_json_args(p.parse_args())

    install_signals()

    if args.check_deps:
        sys.exit(0 if check_deps(DEPS) else EXIT_TOOL_ERROR)

    # Validation for method-specific required args
    if args.method == "ssh":
        missing = [f"--{k}" for k, v in
                   [("host", args.host), ("user", args.user),
                    ("pass", args.password)] if not v]
        if missing:
            fail("E_INVALID_ARGS", f"SSH requires: {', '.join(missing)}",
                 exit_code=EXIT_VALIDATION)
    else:
        if not args.url:
            fail("E_INVALID_ARGS", "HTTP requires --url",
                 exit_code=EXIT_VALIDATION)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        if args.method == "ssh":
            data = _ssh_pull(args.host, args.user, args.password,
                             str(out_dir), args.cmd, args.get)
        else:
            data = _http_pull(args.url, str(out_dir))
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        fail("E_PULL", str(e), {"exception": type(e).__name__})

    data["method"] = args.method
    data["output_dir"] = str(out_dir)
    progress(100, "Complete")
    result(data)
    write_output(args, data)


if __name__ == "__main__":
    main()
