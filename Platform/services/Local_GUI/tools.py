"""Pluggable tool definitions for the Local GUI.

To add a tool: create a Tool(...) and append it to TOOLS (or use @register).
To remove a tool: delete or comment out its entry in TOOLS.

Categories and recommends_for control dropdown grouping and file-based ranking.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from typing import Callable, Optional

# Base path used by Ghidra installs on this testbed image.
GHIDRA_HOME = "/opt/ghidra_12.1.4_PUBLIC"

# Display order for category sections in the tool dropdown / menu.
# id -> label shown in the UI
CATEGORIES: list[tuple[str, str]] = [
    ("reverse_engineering", "Reverse Engineering"),
    ("network", "Network Analysis"),
    ("scripts", "Scripts & Automation"),
]

# File-kind tags used by Tool.recommends_for and detect_file_kind()
KIND_ELF = "elf"
KIND_PCAP = "pcap"
KIND_SCRIPT = "script"


@dataclass(frozen=True)
class Tool:
    """One launchable tool.

    build(file_path, extra_args) -> argv list passed to ToolRunner.
    file_path is None when the user has not selected a file.
    extra_args is already shlex-split from the optional-args field.
    """

    name: str
    build: Callable[[Optional[str], list[str]], list[str]]
    category: str = "scripts"
    recommends_for: frozenset[str] = field(default_factory=frozenset)
    gui: bool = False
    accepts_file: bool = True
    description: str = ""


TOOLS: list[Tool] = []


def register(tool: Tool) -> Tool:
    """Register a tool and return it (handy for inline registration)."""
    TOOLS.append(tool)
    return tool


def get_tool(name: str) -> Optional[Tool]:
    for tool in TOOLS:
        if tool.name == name:
            return tool
    return None


def tool_names() -> list[str]:
    return [t.name for t in TOOLS]


def parse_extra_args(text: str) -> list[str]:
    """Split the optional-args field the same way a shell would."""
    text = (text or "").strip()
    if not text:
        return []
    return shlex.split(text)


def category_header(label: str) -> str:
    return f"── {label} ──"


def is_category_header(entry: str) -> bool:
    text = (entry or "").strip()
    return text.startswith("──") and text.endswith("──")


def detect_file_kind(path: Optional[str]) -> Optional[str]:
    """Classify a selected file for recommendation ranking."""
    if not path:
        return None
    ext = os.path.splitext(path)[1].lower()
    if ext in {".pcap", ".pcapng", ".cap"}:
        return KIND_PCAP
    if ext in {".py", ".sh", ".bash", ".zsh", ".rb", ".pl"}:
        return KIND_SCRIPT
    if ext in {".elf", ".bin", ".so", ".o", ".exe", ".dll", ".out"}:
        return KIND_ELF

    try:
        with open(path, "rb") as fh:
            magic = fh.read(256)
    except OSError:
        return None

    if magic.startswith(b"\x7fELF"):
        return KIND_ELF
    if magic.startswith(b"#!"):
        return KIND_SCRIPT
    # PCAP magic (libpcap + pcapng)
    if magic[:4] in {b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x0a\x0d\x0d\x0a"}:
        return KIND_PCAP
    return None


def recommended_tools(file_path: Optional[str]) -> list[Tool]:
    kind = detect_file_kind(file_path)
    if not kind:
        return []
    return [t for t in TOOLS if kind in t.recommends_for]


def tools_in_category(category_id: str) -> list[Tool]:
    return [t for t in TOOLS if t.category == category_id]


def tool_dropdown_values(file_path: Optional[str] = None) -> list[str]:
    """Flat combobox entries: optional Recommended section, then category groups."""
    entries: list[str] = []

    recommended = recommended_tools(file_path)
    if recommended:
        entries.append(category_header("Recommended"))
        entries.extend(t.name for t in recommended)

    for cat_id, cat_label in CATEGORIES:
        group = tools_in_category(cat_id)
        if not group:
            continue
        entries.append(category_header(cat_label))
        entries.extend(t.name for t in group)

    return entries


# ---------------------------------------------------------------------------
# Built-in tools — comment out or delete any entry to unplug it.
# ---------------------------------------------------------------------------

register(Tool(
    name="Adafruit Bluetooth Sniffer",
    category="network",
    recommends_for=frozenset({KIND_SCRIPT, KIND_PCAP}),
    build=lambda file_path, extra: (
        ["python", "-u", file_path or "sniffer_script.py"] + extra
    ),
    description="Run the Adafruit Bluetooth sniffer script",
))

register(Tool(
    name="Preloaded Script",
    category="network",
    recommends_for=frozenset({KIND_SCRIPT, KIND_PCAP}),
    build=lambda file_path, extra: (
        ["tshark", "-i", "any", "-l", "-f", "bluetooth"] + extra
        if not file_path
        else ["bash", file_path] + extra
    ),
    description="Preloaded capture / analysis script",
))

register(Tool(
    name="Custom Script",
    category="scripts",
    recommends_for=frozenset({KIND_SCRIPT}),
    build=lambda file_path, extra: (
        ["python", "-u", file_path or "custom_script.py"] + extra
    ),
    description="Run a user-provided Python script",
))

register(Tool(
    name="Ghidra (Headless)",
    category="reverse_engineering",
    recommends_for=frozenset({KIND_ELF}),
    build=lambda file_path, extra: (
        [
            f"{GHIDRA_HOME}/support/analyzeHeadless",
            ".",
            "project",
            "-import",
            file_path or "total_recall",
        ]
        + extra
    ),
    description="Ghidra headless analysis",
))

register(Tool(
    name="Ghidra (GUI)",
    category="reverse_engineering",
    recommends_for=frozenset({KIND_ELF}),
    build=lambda file_path, extra: (
        [f"{GHIDRA_HOME}/ghidraRun"]
        + (["-import", file_path] if file_path else [])
        + extra
    ),
    gui=True,
    description="Ghidra graphical workbench",
))

register(Tool(
    name="GDB",
    category="reverse_engineering",
    recommends_for=frozenset({KIND_ELF}),
    build=lambda file_path, extra: (
        ["gdb", file_path or ""] + extra
    ),
    description="GNU debugger",
))

register(Tool(
    name="pwndbg",
    category="reverse_engineering",
    recommends_for=frozenset({KIND_ELF}),
    build=lambda file_path, extra: (
        ["pwndbg", file_path or ""] + extra
    ),
    description="Pwndbg plugin for GDB",
))

register(Tool(
    name="Wireshark",
    category="network",
    recommends_for=frozenset({KIND_PCAP}),
    build=lambda file_path, extra: (
        ["wireshark"]
        + ([file_path] if file_path else [])
        + extra
    ),
    gui=True,
    description="Network protocol analyzer",
))
