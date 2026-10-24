#!/usr/bin/env python3
"""rop_gadgets_scanner.py — ROP gadget discovery via ropper.

The Ghidra coupling from the original GhidraScript version is now optional:
image base is derived from pyghidra when `--use-ghidra-base` is passed,
otherwise ropper's own ELF/PE auto-detection is used. This makes the tool
usable outside a Ghidra GUI session while preserving the Ghidra workflow.
"""
import argparse
import sys
from pathlib import Path

from _re_common import (
    EXIT_TOOL_ERROR, add_common_args, check_deps, ensure_file, fail,
    install_signals, log, merge_json_args, progress, result, try_run,
    write_output,
)

DEPS = {
    "ropper": {"type": "bin", "env": "ROPPER_PATH",
               "required": True, "hint": "pip install ropper"},
    "pyghidra": {"type": "py", "required": False,
                 "hint": "Optional: --use-ghidra-base for accurate image base"},
}

DEFAULT_PATTERNS = [
    "pop rdi; ret", "pop rsi; ret", "pop rdx; ret",
    "pop rax; ret", "pop rbx; ret",
    "syscall", "int 0x80",
    "pop rsp; ret", "leave; ret",
    "system", "execve",
]


def _image_base_via_pyghidra(binary: Path):
    try:
        import pyghidra  # noqa: F401
    except ImportError:
        log("warning", "pyghidra not installed; skipping Ghidra image base")
        return None
    try:
        import pyghidra
        pyghidra.start()
        from pyghidra import open_program
        with open_program(str(binary), analyze=False) as flat_api:
            return flat_api.getCurrentProgram().getImageBase().getOffset()
    except Exception as e:                              # noqa: BLE001
        log("warning", f"pyghidra image-base detection failed: {e}")
        return None


def _parse_ropper(out: str) -> list[str]:
    matches = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("0x") and ":" in line:
            matches.append(line)
    return matches


def search(binary: Path, patterns: list[str],
           image_base: int | None, timeout: int) -> list[dict]:
    results = []
    for i, pattern in enumerate(patterns, 1):
        progress(int(100 * i / len(patterns)), f"Searching: {pattern}")
        cmd = ["ropper", "--file", str(binary),
               "--search", pattern, "--nocolor", "--quiet"]
        if image_base is not None:
            cmd.extend(["-I", hex(image_base)])
        proc = try_run(cmd, timeout=timeout)
        if proc is None:
            log("warning", f"ropper failed or timed out on '{pattern}'")
            results.append({"pattern": pattern, "matches": [], "count": 0,
                            "error": "timeout_or_missing"})
            continue
        matches = _parse_ropper(proc.stdout or "")
        results.append({
            "pattern": pattern,
            "matches": matches,
            "count": len(matches),
            "stderr": (proc.stderr or "").strip() or None,
        })
    return results


def main() -> None:
    p = argparse.ArgumentParser(description="ROP gadget scanner (ropper)")
    p.add_argument("binary", help="ELF/PE binary")
    p.add_argument("--patterns", nargs="*",
                   help="Custom gadget patterns (default: common set)")
    p.add_argument("--image-base", type=lambda x: int(x, 0),
                   help="Image base override (hex or decimal)")
    p.add_argument("--use-ghidra-base", action="store_true",
                   help="Use pyghidra to resolve image base")
    p.add_argument("--timeout", type=int, default=120,
                   help="Per-pattern ropper timeout (s)")
    add_common_args(p)
    args = merge_json_args(p.parse_args())

    install_signals()

    if args.check_deps:
        sys.exit(0 if check_deps(DEPS) else EXIT_TOOL_ERROR)

    try:
        binary = ensure_file(args.binary)
        image_base = args.image_base
        if image_base is None and args.use_ghidra_base:
            image_base = _image_base_via_pyghidra(binary)
            if image_base is not None:
                log("info", f"Image base (ghidra): 0x{image_base:x}")

        patterns = args.patterns or DEFAULT_PATTERNS
        results = search(binary, patterns, image_base, args.timeout)

        data = {
            "binary": str(binary),
            "image_base": hex(image_base) if image_base is not None else None,
            "patterns": patterns,
            "results": results,
            "total_matches": sum(r["count"] for r in results),
        }
        progress(100, "Complete")
        result(data)
        write_output(args, data)
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        fail("E_ROP", str(e), {"exception": type(e).__name__})


if __name__ == "__main__":
    main()
