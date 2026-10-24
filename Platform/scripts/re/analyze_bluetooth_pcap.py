#!/usr/bin/env python3
"""analyze_bluetooth_pcap.py — BLE PCAP reconnaissance using tshark.

The pyshark dependency was replaced with direct `tshark -T fields` and
`-T json` subprocess pipelines so that:
  * No third-party capture parser is needed at runtime.
  * Bulk passes (devices, GATT) stream line-by-line to bound memory.
  * Child tshark processes are reaped on SIGINT / timeout.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

from _re_common import (
    EXIT_TOOL_ERROR, add_common_args, check_deps, ensure_file, fail,
    install_signals, log, merge_json_args, progress, register_cleanup,
    result, run, stream_lines, write_output,
)

DEPS = {
    "tshark": {"type": "bin", "env": "TSHARK_PATH",
               "required": True, "hint": "apt install tshark"},
}

ATT_OPCODES = {
    0x01: "Error Response",
    0x08: "Read By Type Request",
    0x09: "Read By Type Response",
    0x10: "Read By Group Type Request",
    0x11: "Read By Group Type Response",
    0x12: "Write Request",
    0x13: "Write Response",
    0x1B: "Handle Value Notification",
    0x1D: "Handle Value Indication",
    0x52: "Write Command",
}
SMP_OPCODES = {
    0x01: "Pairing Request",
    0x02: "Pairing Response",
    0x03: "Pairing Confirm",
    0x04: "Pairing Random",
    0x05: "Pairing Failed",
    0x06: "Encryption Information",
    0x07: "Master Identification",
    0x0B: "Security Request",
}
DATA_CARRYING = {0x12, 0x1B, 0x1D, 0x52}


def _hex_opcode(s: str) -> int | None:
    if not s:
        return None
    try:
        return int(s, 16) if s.lower().startswith("0x") else int(s)
    except (ValueError, TypeError):
        return None


def _collect_devices(pcap: str, mac_filter: str | None) -> dict:
    fields = ["btle.advertising_address",
              "btcommon.eir_ad.entry.device_name",
              "btcommon.eir_ad.entry.local_name"]
    cmd = ["tshark", "-r", pcap, "-Y", "btle", "-T", "fields",
           "-E", "separator=\t", "-E", "occurrence=f"]
    for f in fields:
        cmd.extend(["-e", f])

    devices = defaultdict(lambda: {"name": None, "packets_seen": 0})
    for line in stream_lines(cmd):
        parts = line.split("\t")
        if not parts or not parts[0]:
            continue
        mac = parts[0].upper()
        if mac_filter and mac != mac_filter.upper():
            continue
        devices[mac]["packets_seen"] += 1
        if not devices[mac]["name"]:
            name = next((p for p in parts[1:] if p), None)
            if name:
                devices[mac]["name"] = name
    return dict(devices)


def _collect_gatt(pcap: str, mac_filter: str | None) -> dict:
    fields = ["btatt.opcode", "btatt.handle", "btatt.value",
              "btatt.starting_handle", "btatt.ending_handle",
              "btatt.uuid16", "btatt.uuid128"]
    cmd = ["tshark", "-r", pcap, "-Y", "btatt", "-T", "fields",
           "-E", "separator=\t", "-E", "occurrence=f"]
    for f in fields:
        cmd.extend(["-e", f])

    services, att_ops, unencrypted = [], [], []
    seen_svcs: set[str] = set()
    for line in stream_lines(cmd):
        parts = line.split("\t") + [""] * 7
        opcode = _hex_opcode(parts[0])
        if opcode is None:
            continue
        desc = ATT_OPCODES.get(opcode, f"Unknown opcode 0x{opcode:02x}")
        handle = parts[1] or None
        value = parts[2] or None

        att_ops.append({"opcode": f"0x{opcode:02x}", "description": desc,
                        "handle": handle, "value": value})

        if opcode == 0x11:
            uuid = (parts[6] or parts[5] or "").upper()
            if uuid and uuid not in seen_svcs:
                seen_svcs.add(uuid)
                services.append({"start_handle": parts[3] or None,
                                 "end_handle": parts[4] or None,
                                 "uuid": uuid})

        if opcode in DATA_CARRYING and value:
            unencrypted.append({"opcode_desc": desc, "handle": handle,
                                "value": value})
    return {"services": services, "att_ops": att_ops,
            "unencrypted_data": unencrypted}


def _collect_pairing(pcap: str) -> list[dict]:
    cmd = ["tshark", "-r", pcap, "-Y", "btsmp", "-T", "json"]
    proc = run(cmd, timeout=900)
    try:
        packets = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        packets = []

    exchanges = []
    for pkt in packets:
        layers = (pkt.get("_source", {}).get("layers")
                  or pkt.get("layers") or {})
        smp = layers.get("btsmp") or {}
        if not smp:
            continue
        opcode = _hex_opcode(smp.get("btsmp.opcode", ""))
        if opcode is None:
            continue
        entry = {"opcode": f"0x{opcode:02x}",
                 "description": SMP_OPCODES.get(opcode,
                                                f"Unknown SMP opcode 0x{opcode:02x}"),
                 "raw": smp}
        if opcode == 0x06:
            entry["warning"] = ("LTK distributed in plaintext — legacy "
                                "pairing detected; traffic decryptable.")
        if opcode == 0x05:
            entry["failure_reason"] = smp.get("btsmp.reason", "unknown")
        exchanges.append(entry)
    return exchanges


def analyze(pcap: str, mac_filter: str | None) -> dict:
    log("info", f"Analyzing {pcap}")
    progress(5, "Pass 1/3 — devices")
    devices = _collect_devices(pcap, mac_filter)

    progress(40, "Pass 2/3 — GATT")
    gatt = _collect_gatt(pcap, mac_filter)

    progress(75, "Pass 3/3 — SMP")
    pairing = _collect_pairing(pcap)

    progress(100, "Complete")
    return {
        "pcap": pcap,
        "mac_filter": mac_filter,
        "devices": devices,
        "gatt": {
            "services_discovered": gatt["services"],
            "att_operation_count": len(gatt["att_ops"]),
            "unencrypted_data_transfers": gatt["unencrypted_data"],
        },
        "pairing_exchanges": pairing,
        "summary": {
            "device_count": len(devices),
            "services_found": len(gatt["services"]),
            "unencrypted_transfers": len(gatt["unencrypted_data"]),
            "pairing_exchanges": len(pairing),
            "ltk_exposed": any(e["opcode"] == "0x06" for e in pairing),
        },
    }


def main() -> None:
    p = argparse.ArgumentParser(
        description="Bluetooth/BLE PCAP reconnaissance (tshark)")
    p.add_argument("pcap", help="Path to .pcap / .pcapng")
    p.add_argument("--filter-mac",
                   help="Restrict to a device MAC (AA:BB:CC:DD:EE:FF)")
    add_common_args(p)
    args = merge_json_args(p.parse_args())

    install_signals()

    if args.check_deps:
        sys.exit(0 if check_deps(DEPS) else EXIT_TOOL_ERROR)

    try:
        pcap = ensure_file(args.pcap)
        data = analyze(str(pcap), args.filter_mac)
    except SystemExit:
        raise
    except Exception as e:                              # noqa: BLE001
        fail("E_BLE", str(e), {"exception": type(e).__name__})

    result(data)
    write_output(args, data)


if __name__ == "__main__":
    main()
