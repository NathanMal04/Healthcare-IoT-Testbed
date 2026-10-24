#!/usr/bin/env python3
"""analyze_entropy.py — Binwalk entropy analysis, structured JSON output.

Rewritten from a fire-and-forget binwalk wrapper into a GUI-callable tool:
  * Emits progress/log/result NDJSON events on stdout.
  * Parses binwalk's tabular entropy output into records + summary stats.
  * Retries without `-J` if the installed binwalk rejects the flag.
"""
import argparse
import json
import sys
from pathlib import Path

from _re_common import (
    EXIT_TOOL_ERROR, add_common_args, check_deps, ensure_file, fail,
    install_signals, log, merge_json_args, progress, result, run, try_run,
    write_output,
)

DEPS = {
    "binwalk": {"type": "bin", "env": "BINWALK_PATH",
                "required": True, "hint": "pip install binwalk"},
}


def _parse_entropy_table(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("DECIMAL", "#")):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            rows.append({
                "offset": int(parts[0]),
                "hex": parts[1],
                "entropy": float(parts[2]),
            })
        except (ValueError, IndexError):
            continue
    return rows


def _try_json(text: str):
    text = text.strip()
    if not text or text[0] not in "{[":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def analyze(firmware: Path, extra_args: list[str] | None) -> tuple[dict, str]:
    log("info", f"Analyzing {firmware}")
    progress(5, "Invoking binwalk")

    cmd = ["binwalk", "-E", "-J", str(firmware)]
    if extra_args:
        cmd[1:1] = extra_args

    proc = run(cmd, timeout=900)
    # Some binwalk builds return non-zero even on success; if the flag -J is
    # rejected, retry once without it and note the fallback.
    if proc.returncode != 0 and "-J" in cmd:
        log("warning", f"binwalk -J failed (rc={proc.returncode}); retrying without -J")
        cmd = [c for c in cmd if c != "-J"]
        retry = try_run(cmd, timeout=900)
        if retry and retry.stdout:
            proc = retry

    progress(65, "Parsing entropy table")
    stdout = proc.stdout or ""
    parsed_json = _try_json(stdout)
    rows = _parse_entropy_table(stdout)

    stats = {}
    if rows:
        vals = [r["entropy"] for r in rows]
        stats = {
            "count": len(vals),
            "min": min(vals),
            "max": max(vals),
            "avg": round(sum(vals) / len(vals), 4),
            "high_entropy_blocks": sum(1 for v in vals if v > 0.9),
            "low_entropy_blocks": sum(1 for v in vals if v < 0.1),
        }

    data = {
        "firmware": str(firmware),
        "size_bytes": firmware.stat().st_size,
        "return_code": proc.returncode,
        "entropy_rows": rows,
        "entropy_stats": stats,
        "binwalk_json": parsed_json,
        "stderr": (proc.stderr or "").strip() or None,
    }
    progress(100, "Complete")
    return data, stdout


def main() -> None:
    p = argparse.ArgumentParser(
        description="Binwalk entropy analysis with NDJSON telemetry")
    p.add_argument("firmware", help="Firmware binary path")
    p.add_argument("--extra-args", nargs="*",
                   help="Extra arguments forwarded to binwalk")
    p.add_argument("--save-raw", metavar="DIR",
                   help="Write binwalk raw stdout to this directory")
    add_common_args(p)
    args = merge_json_args(p.parse_args())

    install_signals()

    if args.check_deps:
        sys.exit(0 if check_deps(DEPS) else EXIT_TOOL_ERROR)

    try:
        firmware = ensure_file(args.firmware)
        data, raw = analyze(firmware, args.extra_args)
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        fail("E_ANALYZE", str(e), {"exception": type(e).__name__})

    if args.save_raw:
        out_dir = Path(args.save_raw)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{firmware.name}_entropy.txt").write_text(raw)
        log("info", f"Raw output saved to {out_dir}")

    result(data)
    write_output(args, data)


if __name__ == "__main__":
    main()
