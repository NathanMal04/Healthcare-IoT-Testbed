#!/usr/bin/env python3
"""buffer_overflow_scanner.py — Ghidra-based dangerous-API & ret2* scanner.

Refactored from a GhidraScript (menu-only) into a headless pyghidra tool that
opens a binary, runs (or skips) auto-analysis, and emits structured findings.
"""
import argparse
import sys
from pathlib import Path

from _re_common import (
    EXIT_TOOL_ERROR, add_common_args, check_deps, ensure_file, fail,
    install_signals, log, merge_json_args, progress, result, write_output,
)

DEPS = {
    "pyghidra": {"type": "py", "required": True,
                 "hint": "pip install pyghidra; set GHIDRA_INSTALL_DIR"},
}

DANGEROUS = {
    "gets":    "UNBOUNDED stack buffer overflow (classic)",
    "scanf":   "Format string or unbounded input",
    "sprintf": "Format string / buffer overflow",
    "strcpy":  "Buffer overflow if dest not sized",
    "strcat":  "Buffer overflow",
    "memcpy":  "Buffer overflow / arbitrary write",
    "strncpy": "Still dangerous if n is user-controlled",
    "read":    "Buffer overflow on stack/heap",
    "fgets":   "Safer but still overflow if size wrong",
    "realloc": "Heap overflow / use-after-free risk",
}


def _analyze_program(program, monitor) -> dict:
    from ghidra.program.model.symbol import FlowType

    fm = program.getFunctionManager()
    ref_mgr = program.getReferenceManager()
    findings: dict[str, list] = {name: [] for name in DANGEROUS}

    funcs = list(fm.getFunctions(True))
    log("info", f"Scanning {len(funcs)} functions")

    for i, func in enumerate(funcs, 1):
        if monitor.isCancelled():
            break
        if i % 500 == 0:
            progress(10 + int(70 * i / max(len(funcs), 1)), "Function scan")
        name = func.getName()
        if name not in DANGEROUS:
            continue

        entry = func.getEntryPoint()
        callers = []
        for ref in ref_mgr.getReferencesTo(entry):
            try:
                if ref.getReferenceType() == FlowType.UNCONDITIONAL_CALL:
                    callers.append(hex(ref.getFromAddress().getOffset()))
            except Exception:
                continue
        findings[name].append({
            "address": hex(entry.getOffset()),
            "description": DANGEROUS[name],
            "callers": callers,
        })

    # ret2* primitive harvesting
    ret2libc, ret2win = [], []
    for func in funcs:
        lname = func.getName().lower()
        addr = hex(func.getEntryPoint().getOffset())
        if "system" in lname or "execve" in lname:
            ret2libc.append({"name": func.getName(), "address": addr})
        if any(k in lname for k in ("win", "flag", "success")):
            ret2win.append({"name": func.getName(), "address": addr})

    # /bin/sh strings (cap at 10 to bound output)
    sh_addrs = []
    addr = program.getMemory().findBytes(
        program.getMinAddress(), b"/bin/sh", None, True, monitor)
    while addr and len(sh_addrs) < 10:
        sh_addrs.append(hex(addr.getOffset()))
        addr = program.getMemory().findBytes(
            addr.next(), b"/bin/sh", None, True, monitor)

    # syscall / int 0x80 sites (cap at 20)
    syscalls = []
    for instr in program.getListing().getInstructions(True):
        m = instr.getMnemonicString().lower()
        if m == "syscall":
            syscalls.append(hex(instr.getAddress().getOffset()))
            if len(syscalls) >= 20:
                break

    return {
        "dangerous_calls": findings,
        "ret2libc_candidates": ret2libc,
        "ret2win_candidates": ret2win,
        "bin_sh_strings": sh_addrs,
        "syscall_sites": syscalls,
    }


def _run(binary: Path, auto_analyze: bool) -> dict:
    import pyghidra
    pyghidra.start()
    from pyghidra import open_program

    progress(5, "Opening binary in pyghidra")
    with open_program(str(binary), analyze=auto_analyze) as flat_api:
        program = flat_api.getCurrentProgram()
        monitor = flat_api.getMonitor()
        return _analyze_program(program, monitor)


def main() -> None:
    p = argparse.ArgumentParser(description="Ghidra buffer-overflow scanner")
    p.add_argument("binary", help="Binary to analyze")
    p.add_argument("--skip-auto-analyze", action="store_true",
                   help="Skip Ghidra auto-analysis (faster, less accurate)")
    add_common_args(p)
    args = merge_json_args(p.parse_args())

    install_signals()

    if args.check_deps:
        sys.exit(0 if check_deps(DEPS) else EXIT_TOOL_ERROR)

    try:
        binary = ensure_file(args.binary)
        findings = _run(binary, auto_analyze=not args.skip_auto_analyze)
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        fail("E_GHIDRA", str(e), {"exception": type(e).__name__})

    data = {"binary": str(binary), **findings}
    progress(100, "Complete")
    result(data)
    write_output(args, data)


if __name__ == "__main__":
    main()
