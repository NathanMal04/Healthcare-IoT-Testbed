"""Try a script on your own machine the way the platform runs it.

    python3 -m platform_sdk.run_local script.py capture.pcap
    python3 -m platform_sdk.run_local script.py test-017.log test-017.pcap --group test-017
    python3 -m platform_sdk.run_local script.py *.pcap --each

Without ``--each`` all the files form one unit (like a group). With
``--each`` the script runs once per file (like ``map`` mode). Outputs go to
``./outputs/<unit>/``. Put this folder's parent on PYTHONPATH, or copy
``platform_sdk`` next to your script.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TYPE_BY_EXTENSION = {
    "pcap": "pcap", "pcapng": "pcap", "cap": "pcap",
    "log": "log", "txt": "log", "json": "log", "jsonl": "log", "csv": "log",
    "bin": "firmware", "img": "firmware", "hex": "firmware", "fw": "firmware",
    "elf": "binary", "so": "binary", "o": "binary", "exe": "binary", "dll": "binary", "apk": "binary",
}


def describe(path: Path, index: int):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "artifactId": f"local-{index}",
        "name": path.name,
        "originalFilename": path.name,
        "type": TYPE_BY_EXTENSION.get(path.suffix.lower().lstrip("."), "other"),
        "sha256": digest,
        "sizeBytes": path.stat().st_size,
        "tags": [],
        "path": str(path.resolve()),
    }


def run_unit(script: Path, files, key: str, out_root: Path) -> int:
    output_dir = out_root / (key or "unit")
    output_dir.mkdir(parents=True, exist_ok=True)
    unit = {"key": key, "inputs": [describe(f, i) for i, f in enumerate(files)]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as manifest:
        json.dump(unit, manifest)
    env = dict(os.environ)
    env.update({
        "PLATFORM_MANIFEST": manifest.name,
        "PLATFORM_OUTPUT_DIR": str(output_dir),
        "PLATFORM_GROUP_KEY": key,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(Path(__file__).resolve().parent.parent), env.get("PYTHONPATH")])),
    })
    if len(files) == 1:
        env["PLATFORM_INPUT"] = str(files[0].resolve())
    result = subprocess.run([sys.executable, "-m", "platform_sdk.driver", str(script)], env=env)
    os.unlink(manifest.name)
    status = "ok" if result.returncode == 0 else f"failed (exit {result.returncode})"
    print(f"[{key or 'unit'}] {status}; outputs in {output_dir}")
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("script", type=Path)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--each", action="store_true", help="run once per file (map mode)")
    parser.add_argument("--group", default="", help="group key to pass to the script")
    parser.add_argument("--out", type=Path, default=Path("outputs"))
    args = parser.parse_args()

    if args.each:
        codes = [run_unit(args.script, [f], f.stem, args.out) for f in args.files]
        return max(codes)
    return run_unit(args.script, args.files, args.group, args.out)


if __name__ == "__main__":
    sys.exit(main())
