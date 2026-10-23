"""Entry point for L1 and L2 scripts: ``python3 -m platform_sdk.driver /app/script.py``.

The launcher runs this once per work unit. It imports the user's script and
calls its ``run(ctx)``. A non-zero exit marks the unit as failed; the last
lines of stderr are kept as the reason.
"""
import importlib.util
import sys
import traceback
from pathlib import Path

from platform_sdk import context_from_env


def load_script(path: Path):
    # The script's own folder goes first on sys.path, so an L2 project can
    # import its sibling modules.
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("user_script", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["user_script"] = module
    spec.loader.exec_module(module)
    return module


def main(argv):
    if len(argv) != 2:
        print("usage: python3 -m platform_sdk.driver <script.py>", file=sys.stderr)
        return 2

    script = Path(argv[1])
    try:
        module = load_script(script)
    except Exception:
        traceback.print_exc()
        return 1

    run = getattr(module, "run", None)
    if not callable(run):
        print(f"{script.name} does not define run(ctx)", file=sys.stderr)
        return 1

    ctx = context_from_env()
    try:
        run(ctx)
    except Exception:
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
