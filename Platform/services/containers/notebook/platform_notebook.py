"""Notebook helpers: the same ``ctx`` a script's ``run(ctx)`` gets.

    from platform_notebook import context
    ctx = context()                  # every file staged into this session
    ctx = context("capture.pcap")    # just these (file name or artifact id)

    ctx.input, ctx.inputs, ctx.first(type="pcap"), ctx.by_type("log")
    ctx.output("summary.json")       # under /work/outputs

"Save as script" on the notebook page drops these lines and wraps the rest
of the notebook in ``run(ctx)``, so the same code runs over many files in a
run. Files staged into the session are in /work/inputs; only /work/notebooks
is kept between sessions.
"""
import json
from pathlib import Path

try:
    from platform_sdk import Context, InputFile
except ImportError as e:  # every platform environment has the SDK
    raise ImportError("platform_sdk isn't available in this environment") from e

MANIFEST = Path("/work/.platform/manifest.json")
OUTPUTS = Path("/work/outputs")

__all__ = ["context", "inputs"]


def inputs():
    """The staged files, as platform_sdk InputFile entries."""
    entries = json.loads(MANIFEST.read_text()).get("inputs", []) if MANIFEST.exists() else []
    return [
        InputFile(
            path=Path(e["path"]),
            artifact_id=e["artifactId"],
            name=e.get("name") or Path(e["path"]).name,
            type=e.get("type") or "other",
            sha256=e.get("sha256") or "",
            size_bytes=int(e.get("sizeBytes") or 0),
            tags=list(e.get("tags") or []),
            original_filename=e.get("originalFilename") or "",
        )
        for e in entries
    ]


def context(*names):
    """A Context over all staged files, or only those named (by file name,
    staged path name or artifact id)."""
    files = inputs()
    if names:
        wanted = set(names)
        chosen = [f for f in files if {f.name, f.path.name, f.artifact_id} & wanted]
        found = {k for f in chosen for k in (f.name, f.path.name, f.artifact_id)}
        missing = sorted(wanted - found)
        if missing:
            raise FileNotFoundError(f"Not staged in this session: {', '.join(missing)}")
        files = chosen
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    return Context(inputs=files, output_dir=OUTPUTS, group_key="notebook")
