# analyze_bluetooth_pcap.py
#
# PURPOSE:
#   Reconnaissance tool — analyzes a Bluetooth/BLE PCAP capture file and
#   produces a structured JSON report of:
#     - Observed BLE devices (MAC addresses and advertised names)
#     - GATT services and characteristic handles discovered in the capture
#     - Unencrypted ATT payloads (writes, notifications, indications)
#     - SMP pairing exchanges (indicates pairing method and any failures)
#
# WORKFLOW CONTEXT:
#   This script covers the analysis phase only. Actual exploitation (e.g.
#   writing to GATT handles, replaying packets) requires a live Bluetooth
#   adapter and separate tools (gatttool, bluetoothctl, scapy). Use the
#   output of this script to identify targets and handles for those tools.
#
# CAPTURE REQUIREMENTS:
#   The PCAP must be produced by a hardware BLE sniffer, e.g.:
#     - Ubertooth One:  ubertooth-btle -f -c capture.pcap
#     - nRF Sniffer:    captured via nRF Sniffer for Bluetooth LE plugin in Wireshark
#     - TI CC2540:      captured via SmartRF Packet Sniffer 2
#   The capture link-layer type must be LINKTYPE_BLUETOOTH_LE_LL (DLT 251)
#   or LINKTYPE_BLUETOOTH_HCI_H4 (DLT 187). Standard Wi-Fi adapters cannot
#   capture Bluetooth traffic.
#
# DEPENDENCIES:
#   - tshark (installed in the container via apt)
#   - pyshark (installed via pip)
#
# USAGE:
#   python3 analyze_bluetooth_pcap.py capture.pcap
#   python3 analyze_bluetooth_pcap.py capture.pcap --out /workspace/report.json
#   python3 analyze_bluetooth_pcap.py capture.pcap --filter-mac AA:BB:CC:DD:EE:FF

import argparse
import json
import sys
import pyshark
from pathlib import Path
from collections import defaultdict

# ── ATT opcode reference (Bluetooth Core Spec, Vol 3, Part F, Section 3.4) ───
# Only opcodes that carry data relevant to reconnaissance are listed here.
ATT_OPCODES = {
    0x01: 'Error Response',
    0x08: 'Read By Type Request',       # GATT characteristic discovery
    0x09: 'Read By Type Response',      # returns characteristic declarations
    0x10: 'Read By Group Type Request', # GATT service discovery
    0x11: 'Read By Group Type Response',# returns service UUIDs + handle ranges
    0x12: 'Write Request',              # client writes to a handle (expects response)
    0x13: 'Write Response',
    0x1b: 'Handle Value Notification',  # server pushes data without ack
    0x1d: 'Handle Value Indication',    # server pushes data with ack
    0x52: 'Write Command',              # client writes to a handle (no response)
}

# ── SMP opcode reference (Bluetooth Core Spec, Vol 3, Part H, Section 3.3) ──
SMP_OPCODES = {
    0x01: 'Pairing Request',
    0x02: 'Pairing Response',
    0x03: 'Pairing Confirm',
    0x04: 'Pairing Random',
    0x05: 'Pairing Failed',
    0x06: 'Encryption Information',     # LTK distributed — high value if captured
    0x07: 'Master Identification',      # EDIV + Rand distributed
    0x0b: 'Security Request',
}

# ATT opcodes whose payload field contains data written to or notified from a
# characteristic (i.e. directly readable if the connection is unencrypted).
DATA_CARRYING_OPCODES = {0x12, 0x1b, 0x1d, 0x52}


def safe_get(layer, field_name):
    """Return a pyshark layer field value, or None if the field is absent."""
    try:
        return getattr(layer, field_name)
    except AttributeError:
        return None


def get_layer(packet, layer_name):
    """Return a pyshark layer by name, or None if the packet lacks that layer."""
    try:
        return getattr(packet, layer_name)
    except AttributeError:
        return None


def collect_devices(pcap_path, mac_filter=None):
    """
    Pass 1 — collect BLE advertising devices.

    Reads advertising PDUs (ADV_IND, ADV_NONCONN_IND, SCAN_RSP etc.) to build
    a map of MAC address → device name. The device name is present only when the
    advertiser includes a Complete or Shortened Local Name AD type; many devices
    do not advertise a name.

    Returns:
        dict: { mac_str: { 'name': str|None, 'packets_seen': int } }
    """
    devices = defaultdict(lambda: {'name': None, 'packets_seen': 0})

    try:
        cap = pyshark.FileCapture(pcap_path, display_filter='btle')
    except Exception as e:
        print(f'[!] Failed to open PCAP for device scan: {e}', file=sys.stderr)
        return devices

    try:
        for packet in cap:
            btle = get_layer(packet, 'btle')
            if btle is None:
                continue

            mac = safe_get(btle, 'advertising_address')
            if mac is None:
                continue

            mac = mac.upper()
            if mac_filter and mac != mac_filter.upper():
                continue

            devices[mac]['packets_seen'] += 1

            # Device name lives in the btcommon_eir_ad layer when present.
            # Only overwrite if we haven't already found a name for this MAC.
            if devices[mac]['name'] is None:
                eir = get_layer(packet, 'btcommon_eir_ad')
                if eir is not None:
                    name = safe_get(eir, 'entry_data_local_name')
                    if name:
                        devices[mac]['name'] = str(name)
    except Exception as e:
        print(f'[!] Error during device scan: {e}', file=sys.stderr)
    finally:
        cap.close()

    return dict(devices)


def collect_gatt(pcap_path, mac_filter=None):
    """
    Pass 2 — collect GATT service/characteristic discovery responses and
    any unencrypted data-carrying ATT operations.

    The GATT service and characteristic UUIDs are present in Read By Group
    Type Response and Read By Type Response PDUs respectively, which are
    emitted during the initial connection setup when the client performs
    service discovery.

    Returns:
        dict: {
            'services':   [ { 'start_handle': hex, 'end_handle': hex, 'uuid': str } ],
            'att_ops':    [ { 'opcode': hex, 'description': str, 'handle': hex|None,
                              'value': str|None } ],
            'unencrypted_data': [ { 'opcode_desc': str, 'handle': hex, 'value': str } ]
        }
    """
    results = {
        'services': [],
        'att_ops': [],
        'unencrypted_data': [],
    }
    seen_services = set()

    try:
        cap = pyshark.FileCapture(pcap_path, display_filter='btatt')
    except Exception as e:
        print(f'[!] Failed to open PCAP for GATT scan: {e}', file=sys.stderr)
        return results

    try:
        for packet in cap:
            btatt = get_layer(packet, 'btatt')
            if btatt is None:
                continue

            raw_opcode = safe_get(btatt, 'opcode')
            if raw_opcode is None:
                continue

            try:
                opcode = int(raw_opcode, 16)
            except (ValueError, TypeError):
                continue

            description = ATT_OPCODES.get(opcode, f'Unknown opcode 0x{opcode:02x}')
            handle = safe_get(btatt, 'handle')
            value = safe_get(btatt, 'value')

            results['att_ops'].append({
                'opcode': f'0x{opcode:02x}',
                'description': description,
                'handle': str(handle) if handle else None,
                'value': str(value) if value else None,
            })

            # Extract service declarations from Read By Group Type Response.
            if opcode == 0x11:
                start = safe_get(btatt, 'starting_handle')
                end   = safe_get(btatt, 'ending_handle')
                uuid  = safe_get(btatt, 'uuid128') or safe_get(btatt, 'uuid16')
                if uuid:
                    key = str(uuid).upper()
                    if key not in seen_services:
                        seen_services.add(key)
                        results['services'].append({
                            'start_handle': str(start) if start else None,
                            'end_handle':   str(end)   if end   else None,
                            'uuid': key,
                        })

            # Flag unencrypted data — these opcodes carry application data in
            # plaintext when the BLE connection is not encrypted. If encrypted,
            # the value field in the PCAP will appear as ciphertext and will not
            # be meaningful here.
            if opcode in DATA_CARRYING_OPCODES and value:
                results['unencrypted_data'].append({
                    'opcode_desc': description,
                    'handle': str(handle) if handle else None,
                    'value': str(value),
                })
    except Exception as e:
        print(f'[!] Error during GATT scan: {e}', file=sys.stderr)
    finally:
        cap.close()

    return results


def collect_pairing(pcap_path):
    """
    Pass 3 — collect SMP pairing exchanges.

    Pairing exchanges are significant because:
      - The pairing method (Just Works, Passkey, OOB) determines attack surface.
      - Just Works provides no MITM protection.
      - If Encryption Information (0x06) PDUs are present, the LTK was distributed
        in the clear — this only occurs with legacy pairing (BLE 4.0/4.1) and
        represents a critical finding.
      - Pairing Failed PDUs indicate the reason code, which can reveal
        security policy details of the target device.

    Returns:
        list: [ { 'opcode': hex, 'description': str, 'raw_fields': dict } ]
    """
    exchanges = []

    try:
        cap = pyshark.FileCapture(pcap_path, display_filter='btsmp')
    except Exception as e:
        print(f'[!] Failed to open PCAP for SMP scan: {e}', file=sys.stderr)
        return exchanges

    try:
        for packet in cap:
            btsmp = get_layer(packet, 'btsmp')
            if btsmp is None:
                continue

            raw_opcode = safe_get(btsmp, 'opcode')
            if raw_opcode is None:
                continue

            try:
                opcode = int(raw_opcode, 16)
            except (ValueError, TypeError):
                continue

            description = SMP_OPCODES.get(opcode, f'Unknown SMP opcode 0x{opcode:02x}')

            # Collect all available fields for this SMP PDU without assuming
            # which specific sub-fields are present (they vary by opcode).
            raw_fields = {}
            for field in btsmp.field_names:
                val = safe_get(btsmp, field)
                if val is not None:
                    raw_fields[field] = str(val)

            entry = {
                'opcode': f'0x{opcode:02x}',
                'description': description,
                'raw_fields': raw_fields,
            }

            if opcode == 0x06:
                entry['warning'] = (
                    'LTK distributed in plaintext — legacy pairing detected. '
                    'This key can be used to decrypt previously captured encrypted traffic.'
                )

            if opcode == 0x05:
                reason = raw_fields.get('reason', 'unknown')
                entry['failure_reason'] = reason

            exchanges.append(entry)
    except Exception as e:
        print(f'[!] Error during SMP scan: {e}', file=sys.stderr)
    finally:
        cap.close()

    return exchanges


def analyze(pcap_path, mac_filter=None):
    """
    Run all three analysis passes and return a combined report dict.
    """
    print(f'[*] Analyzing: {pcap_path}')

    print('[*] Pass 1/3 — scanning for BLE advertising devices...')
    devices = collect_devices(pcap_path, mac_filter)

    print('[*] Pass 2/3 — scanning GATT/ATT operations...')
    gatt = collect_gatt(pcap_path, mac_filter)

    print('[*] Pass 3/3 — scanning SMP pairing exchanges...')
    pairing = collect_pairing(pcap_path)

    report = {
        'pcap_file': str(pcap_path),
        'mac_filter': mac_filter,
        'devices': devices,
        'gatt': {
            'services_discovered': gatt['services'],
            'att_operation_count': len(gatt['att_ops']),
            'att_operations': gatt['att_ops'],
            'unencrypted_data_transfers': gatt['unencrypted_data'],
        },
        'pairing_exchanges': pairing,
        'summary': {
            'device_count': len(devices),
            'services_found': len(gatt['services']),
            'unencrypted_transfers': len(gatt['unencrypted_data']),
            'pairing_exchanges': len(pairing),
            'ltk_exposed': any(e['opcode'] == '0x06' for e in pairing),
        },
    }

    return report


def print_summary(report):
    s = report['summary']
    print('\n── Summary ──────────────────────────────────────')
    print(f"  Devices seen:              {s['device_count']}")
    print(f"  GATT services found:       {s['services_found']}")
    print(f"  Unencrypted data xfers:    {s['unencrypted_transfers']}")
    print(f"  SMP pairing exchanges:     {s['pairing_exchanges']}")
    print(f"  LTK exposed (legacy pair): {s['ltk_exposed']}")

    if report['devices']:
        print('\n── Devices ──────────────────────────────────────')
        for mac, info in report['devices'].items():
            name = info['name'] or '(no name advertised)'
            print(f"  {mac}  {name}  [{info['packets_seen']} adv pkts]")

    if report['gatt']['services_discovered']:
        print('\n── GATT Services ────────────────────────────────')
        for svc in report['gatt']['services_discovered']:
            print(f"  UUID: {svc['uuid']}  "
                  f"handles {svc['start_handle']}–{svc['end_handle']}")

    if report['gatt']['unencrypted_data_transfers']:
        print('\n── Unencrypted Data Transfers ───────────────────')
        for xfer in report['gatt']['unencrypted_data_transfers']:
            print(f"  [{xfer['opcode_desc']}]  "
                  f"handle={xfer['handle']}  value={xfer['value']}")

    if report['pairing_exchanges']:
        print('\n── Pairing Exchanges ────────────────────────────')
        for ex in report['pairing_exchanges']:
            line = f"  {ex['opcode']} {ex['description']}"
            if 'warning' in ex:
                line += f"\n    !! {ex['warning']}"
            if 'failure_reason' in ex:
                line += f"\n    Failure reason: {ex['failure_reason']}"
            print(line)

    print('─────────────────────────────────────────────────\n')


def main():
    p = argparse.ArgumentParser(
        description='Analyze a Bluetooth/BLE PCAP capture for reconnaissance.'
    )
    p.add_argument('pcap', help='Path to the .pcap or .pcapng capture file')
    p.add_argument('--out', help='Write JSON report to this path (optional)')
    p.add_argument(
        '--filter-mac',
        metavar='MAC',
        help='Restrict analysis to a specific device MAC (e.g. AA:BB:CC:DD:EE:FF)'
    )
    args = p.parse_args()

    pcap_path = Path(args.pcap)
    if not pcap_path.is_file():
        p.error(f'PCAP file not found: {pcap_path}')

    report = analyze(str(pcap_path), args.filter_mac)
    print_summary(report)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2))
        print(f'[*] Report written to {out_path}')


if __name__ == '__main__':
    main()
