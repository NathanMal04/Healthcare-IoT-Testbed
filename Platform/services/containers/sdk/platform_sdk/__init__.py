"""Helpers for scripts run by the platform.

A script defines ``run(ctx)``. The platform calls it once per work unit: one
input file, or a group of files that belong together (for example a log and
a pcap from the same test). Everything the script needs is on ``ctx``:

    def run(ctx):
        data = ctx.input.read_bytes()            # single-file units
        pcap = ctx.first(type="pcap")            # grouped units
        logs = ctx.by_type("log")
        ctx.output("summary.json").write_text("{}")

Files written under ``ctx.output_dir`` become new artifacts, linked back to
the unit's inputs. The script has no network access and no AWS credentials;
inputs are already on local disk.
"""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

__all__ = ["Context", "InputFile", "context_from_env"]


@dataclass(frozen=True)
class InputFile:
    path: Path
    artifact_id: str
    name: str
    type: str
    sha256: str
    size_bytes: int
    tags: List[str] = field(default_factory=list)
    original_filename: str = ""

    def read_bytes(self) -> bytes:
        return self.path.read_bytes()

    def read_text(self, encoding: str = "utf-8", errors: str = "replace") -> str:
        return self.path.read_text(encoding=encoding, errors=errors)


@dataclass
class Context:
    inputs: List[InputFile]
    output_dir: Path
    group_key: str

    @property
    def input(self) -> Path:
        """Path of the unit's only input. Use ``inputs`` for grouped units."""
        if len(self.inputs) != 1:
            raise AttributeError(
                f"This unit has {len(self.inputs)} inputs; use ctx.inputs, ctx.first() or ctx.by_type()"
            )
        return self.inputs[0].path

    @property
    def input_meta(self) -> InputFile:
        if len(self.inputs) != 1:
            raise AttributeError(f"This unit has {len(self.inputs)} inputs; use ctx.inputs")
        return self.inputs[0]

    def by_type(self, type: str) -> List[InputFile]:
        return [f for f in self.inputs if f.type == type]

    def first(self, type: Optional[str] = None) -> Optional[Path]:
        """Path of the first input (of ``type``, if given), or None."""
        matches = self.by_type(type) if type else self.inputs
        return matches[0].path if matches else None

    def output(self, name: str) -> Path:
        """Path for an output file under output_dir; parent folders are created."""
        path = (self.output_dir / name).resolve()
        if self.output_dir.resolve() not in path.parents:
            raise ValueError(f"Output path escapes the output folder: {name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path


def context_from_env() -> Context:
    """Builds the context from the variables the launcher sets."""
    manifest_path = os.environ.get("PLATFORM_MANIFEST")
    output_dir = Path(os.environ.get("PLATFORM_OUTPUT_DIR", "/work/outputs"))
    if not manifest_path:
        raise RuntimeError("PLATFORM_MANIFEST is not set; is this running under the platform launcher?")

    unit = json.loads(Path(manifest_path).read_text())
    inputs = [
        InputFile(
            path=Path(item["path"]),
            artifact_id=item["artifactId"],
            name=item.get("name") or Path(item["path"]).name,
            type=item.get("type") or "other",
            sha256=item.get("sha256") or "",
            size_bytes=int(item.get("sizeBytes") or 0),
            tags=list(item.get("tags") or []),
            original_filename=item.get("originalFilename") or "",
        )
        for item in unit.get("inputs", [])
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    return Context(inputs=inputs, output_dir=output_dir, group_key=unit.get("key", ""))
