#!/usr/bin/env python3
"""unsanitized_text_entries_scanner.py — Ghidra scanner for unsanitized input.

Finds dangerous input-accepting functions, their callers, and suspicious
user-controlled-looking strings. Runs headless via pyghidra.
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

INPUT_FUNCS = {
    "gets":    "NEVER safe - unbounded stack read",
    "scanf":   "Unbounded %s or missing width",
    "fscanf":  "Same as scanf",
    "sscanf":  "Same as scanf",
    "read":    "Raw read into buffer (check size)",
    "recv":    "Network input - check length",
    "fgets":   "Safer only if size is constant & correct",
    "getline": "Dynamic but still needs bounds checking",
    "getchar": "Loop risk if not bounded",
}

SUSPICIOUS_KEYS = ("input", "user", "name", "pass", "cmd")


def _analyze(program, monitor) -> dict:
    from ghidra.program.model.symbol import FlowType

    fm = program.getFunctionManager()
    ref_mgr = program.getReferenceManager()
    findings: dict[str, list] = {name: [] for name in INPUT_FUNCS}

    funcs = list(fm.getFunctions(True))
    log("info", f"Scanning {len(funcs)} functions")

    for i, func in enumerate(funcs, 1):
        if monitor.isCancelled():
            break
        if i % 500 == 0:
            progress(10 + int(50 * i / max(len(funcs), 1)), "Function scan")
        name = func.getName()
        if name not in INPUT_FUNCS:
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
            "risk": INPUT_FUNCS[name],
            "callers": callers,
        })

    progress(70, "Scanning strings")
    suspicious = []
    listing = program.getListing()
    for data in listing.getDefinedData(True):
        if monitor.isCancelled():
            break
        try:
            if not data.isString():
                continue
            s = str(data.getValue())
        except Exception:
            continue
        if len(s) > 10 and any(kw in s.lower() for kw in SUSPICIOUS_KEYS):
            suspicious.append({
                "address": hex(data.getAddress().getOffset()),
                "value": s[:120],
            })
        if len(suspicious) >= 200:
            break

    return {"input_functions": findings,
            "suspicious_strings": suspicious}


def _run(binary: Path, auto_analyze: bool) -> dict:
    import pyghidra
    pyghidra.start()
    from pyghidra import open_program
    progress(5, "Opening binary in pyghidra")
    with open_program(str(binary), analyze=auto_analyze) as flat_api:
        return _analyze(flat_api.getCurrentProgram(), flat_api.getMonitor())


def main() -> None:
    p = argparse.ArgumentParser(
        description="Ghidra unsanitized input scanner")
    p.add_argument("binary", help="Binary to analyze")
    p.add_argument("--skip-auto-analyze", action="store_true")
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
