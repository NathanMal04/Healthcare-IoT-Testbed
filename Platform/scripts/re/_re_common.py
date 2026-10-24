"""_re_common.py — shared utilities for GUI-integrated RE scripts.

Design goals:
  * Fast --help / --check-deps (< 50 ms): no heavy imports at module scope.
  * NDJSON event protocol on stdout (progress / log / result / error / deps).
  * Signal-aware cleanup registry (SIGINT / SIGTERM).
  * Standard exit codes: 0 ok, 1 validation, 2 tool, 3 timeout, 130 SIGINT.
  * Tool path overrides via environment variables.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_VALIDATION = 1
EXIT_TOOL_ERROR = 2
EXIT_TIMEOUT = 3
EXIT_INTERRUPT = 130

_cleanup_fns: list = []


# ── Cleanup / signals ────────────────────────────────────────────────────
def register_cleanup(fn):
    _cleanup_fns.append(fn)


def run_cleanup():
    while _cleanup_fns:
        try:
            _cleanup_fns.pop()()
        except Exception:
            pass


def _handle_signal(signum, frame):
    run_cleanup()
    sys.exit(EXIT_INTERRUPT)


def install_signals():
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


# ── NDJSON event emitters ────────────────────────────────────────────────
def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(percent: int, status: str, **extra) -> None:
    emit({"type": "progress", "percent": int(percent), "status": status, **extra})


def log(level: str, message: str, **extra) -> None:
    emit({"type": "log", "level": level, "message": message, **extra})


def result(data) -> None:
    emit({"type": "result", "data": data})


def error(code: str, message: str, details=None) -> None:
    emit({"type": "error", "code": code, "message": message, "details": details})


def fail(code: str, message: str, details=None,
         exit_code: int = EXIT_TOOL_ERROR) -> None:
    error(code, message, details)
    run_cleanup()
    sys.exit(exit_code)


# ── Tool / dependency handling ───────────────────────────────────────────
def _find_spec(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def which(name: str, env_var: str | None = None) -> str | None:
    if env_var:
        override = os.environ.get(env_var)
        if override:
            return override if Path(override).is_file() else None
    return shutil.which(name)


def check_deps(spec: dict) -> bool:
    """Emit a `deps` event. spec: {name: {type,env,hint,required}}."""
    all_ok = True
    out = {}
    for name, info in spec.items():
        kind = info.get("type", "bin")
        available = False
        path = None
        if kind == "bin":
            path = which(name, info.get("env"))
            available = path is not None
        elif kind == "py":
            available = _find_spec(name)
            path = name if available else None
        elif kind == "env":
            path = os.environ.get(info["env"])
            available = bool(path)
        required = info.get("required", True)
        out[name] = {
            "available": available,
            "path": path,
            "required": required,
            "hint": info.get("hint"),
        }
        if required and not available:
            all_ok = False
    emit({"type": "deps", "ok": all_ok, "dependencies": out})
    return all_ok


# ── CLI helpers ──────────────────────────────────────────────────────────
def add_common_args(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument("--json-args", metavar="JSON",
                        help="JSON object of arguments to merge into namespace")
    parser.add_argument("--check-deps", action="store_true",
                        help="Report tool availability and exit")
    parser.add_argument("--output", "-o",
                        help="Write final result JSON to this path")
    return parser


def merge_json_args(args: argparse.Namespace) -> argparse.Namespace:
    raw = getattr(args, "json_args", None)
    if not raw:
        return args
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        fail("E_INVALID_ARGS", f"Invalid --json-args: {e}",
             exit_code=EXIT_VALIDATION)
    if not isinstance(data, dict):
        fail("E_INVALID_ARGS", "--json-args must be a JSON object",
             exit_code=EXIT_VALIDATION)
    for key, val in data.items():
        setattr(args, key.replace("-", "_"), val)
    return args


# ── Subprocess helpers ───────────────────────────────────────────────────
def run(cmd, timeout=None):
    """Run a subprocess; on error exit with a structured error event."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        fail("E_TIMEOUT", f"Timeout after {timeout}s running {cmd[0]}",
             {"cmd": cmd}, EXIT_TIMEOUT)
    except FileNotFoundError:
        fail("E_TOOL_MISSING", f"Executable not found: {cmd[0]}", {"cmd": cmd})
    except OSError as e:
        fail("E_TOOL_ERROR", f"Failed to run {cmd[0]}: {e}", {"cmd": cmd})


def try_run(cmd, timeout=None):
    """Non-fatal variant: return CompletedProcess or None."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def stream_lines(cmd):
    """Yield stdout lines from a subprocess; guarantees child cleanup."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1)

    def _kill():
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    register_cleanup(_kill)
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        _kill()
        for f in (proc.stdout, proc.stderr):
            try:
                f.close()
            except Exception:
                pass


# ── Filesystem helpers ───────────────────────────────────────────────────
def ensure_file(path: str | Path, code: str = "E_FILE_MISSING") -> Path:
    p = Path(path)
    if not p.is_file():
        fail(code, f"File not found: {path}", {"path": str(path)},
             exit_code=EXIT_VALIDATION)
    return p


def write_output(args, data) -> None:
    path = getattr(args, "output", None)
    if path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=2))
