#!/usr/bin/env python3
"""Builds one environment or script image inside CodeBuild.

Started by builds-api with these environment variables:

  BUILD_KIND      env | script
  LEVEL           L1 | L2 | L3                      (scripts)
  SOURCE_URL      presigned GET of the uploaded source (scripts)
  BASE_IMAGE      image to build FROM: an environment digest (env, L1, L2)
  CATALOG_ITEMS   JSON list of catalog ids to install (env)
  PLATFORM_IMAGE  platform-base digest; /opt/platform is copied from it
  IMAGE_REPO      ECR repository URI (project variable)
  IMAGE_TAG       tag to push, e.g. mod-<id>-3 or env-<id>-2
  RESULTS_POST    JSON {url, fields, prefix}: presigned POST for the package lists

Writes /tmp/out/image_uri (repo@sha256:...) on success, or /tmp/out/error
with a short reason on failure. The buildspec exports both.

Only the standard library is used, since this runs on the stock CodeBuild
image.
"""
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.request
import uuid
import zipfile
from pathlib import Path

OUT = Path("/tmp/out")
WORK = Path("/tmp/work")
HERE = Path(__file__).resolve().parent

# Zip limits, matching the checks builds-api does before starting the build.
MAX_ZIP_ENTRIES = 2000
MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024
MAX_ZIP_RATIO = 100

CREDENTIAL_ENDPOINTS = ["169.254.170.2", "169.254.169.254"]

PEP723_BLOCK = re.compile(
    r"(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$"
)
# Name, optional extras and a version specifier. URLs, paths, "-r", "-e"
# and index options are all rejected.
REQUIREMENT = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._, -]+\])?"
    r"\s*((===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*(,\s*(===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*)*)?"
    r"(\s*;\s*[^@]+)?$"
)


class BuildError(Exception):
    """A problem with the user's input; the message is shown to them."""


# --- Pure helpers (unit-tested) ----------------------------------------------

def pep723_dependencies(source: str) -> list:
    """Returns the dependencies from a PEP 723 `script` block."""
    blocks = [m for m in PEP723_BLOCK.finditer(source) if m.group("type") == "script"]
    if len(blocks) > 1:
        raise BuildError("More than one `# /// script` block")
    if not blocks:
        return []
    content = "".join(
        line[2:] if line.startswith("# ") else line[1:]
        for line in blocks[0].group("content").splitlines(keepends=True)
    )
    deps = _toml_dependencies(content)
    if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
        raise BuildError("`dependencies` must be a list of strings")
    return [check_requirement(d) for d in deps]


def _toml_dependencies(content: str):
    """Reads `dependencies` from a PEP 723 block. Uses tomllib when the
    CodeBuild image's Python has it (3.11+), and a narrow fallback for the
    one key we need otherwise."""
    try:
        import tomllib
    except ImportError:
        tomllib = None
    if tomllib is not None:
        try:
            return tomllib.loads(content).get("dependencies", [])
        except tomllib.TOMLDecodeError as e:
            raise BuildError(f"The `# /// script` block is not valid TOML: {e}")
    import ast
    match = re.search(r"(?m)^dependencies\s*=\s*\[", content)
    if not match:
        return []
    # Find the closing bracket, ignoring brackets inside quoted strings
    # (extras like "numpy[extra]").
    start = match.end() - 1
    depth, quote = 0, None
    for i in range(start, len(content)):
        ch = content[i]
        if quote:
            if ch == quote and content[i - 1] != "\\":
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                try:
                    return ast.literal_eval(content[start:i + 1])
                except (ValueError, SyntaxError):
                    break
    raise BuildError("`dependencies` in the `# /// script` block must be a list of strings")


def requirements_file(text: str) -> list:
    """Parses requirements.txt, allowing only plain `name[extras] specifier` lines."""
    reqs = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            reqs.append(check_requirement(line))
    return reqs


def check_requirement(req: str) -> str:
    req = req.strip()
    if not REQUIREMENT.match(req) or "://" in req or "@" in req:
        raise BuildError(
            f"Unsupported dependency {req!r}: use a package name and version only (no URLs, paths or options)"
        )
    return req


def safe_extract(zip_bytes: bytes, dest: Path) -> None:
    """Extracts a zip with limits on entries, total size and compression
    ratio, refusing links and paths that escape `dest`. Sizes are counted
    while streaming, so a lying header can't get past the limits."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise BuildError("The upload is not a valid zip file")

    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise BuildError(f"The zip has more than {MAX_ZIP_ENTRIES} entries")

    dest = dest.resolve()
    total = 0
    for info in infos:
        name = info.filename
        if name.startswith("/") or "\\" in name or ".." in Path(name).parts:
            raise BuildError(f"Unsafe path in zip: {name}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise BuildError(f"Links are not allowed in the zip: {name}")
        target = (dest / name).resolve()
        if target != dest and dest not in target.parents:
            raise BuildError(f"Unsafe path in zip: {name}")
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if info.compress_size and info.file_size / info.compress_size > MAX_ZIP_RATIO:
            raise BuildError(f"{name} is compressed suspiciously well (possible zip bomb)")
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(info) as src, open(target, "wb") as out:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ZIP_TOTAL_BYTES:
                    raise BuildError(f"The zip expands to more than {MAX_ZIP_TOTAL_BYTES // (1024 * 1024)} MB")
                out.write(chunk)


def wrapper_stage(platform_image: str, work_dir: str = "/work") -> str:
    """The layer every image ends with: the launcher and SDK from
    platform-base, and the launcher as the entrypoint. The command it runs
    comes from the Batch job definition, not the image."""
    return (
        f"COPY --from={platform_image} /opt/platform /opt/platform\n"
        "ENV PYTHONPATH=/opt/platform/sdk${PYTHONPATH:+:$PYTHONPATH} \\\n"
        "    PYTHONUNBUFFERED=1 \\\n"
        f"    PLATFORM_WORK_DIR={work_dir}\n"
        'ENTRYPOINT ["/opt/platform/launcher"]\n'
        "CMD []\n"
    )


def env_dockerfile(base_image: str, items: list, platform_image: str) -> str:
    apt = sorted({pkg for item in items for pkg in item.get("apt", [])})
    pip = sorted({pkg for item in items for pkg in item.get("pip", [])})
    lines = [f"FROM {base_image}"]
    if apt:
        lines.append(
            "RUN apt-get update && apt-get install -y --no-install-recommends "
            + " ".join(apt)
            + " && rm -rf /var/lib/apt/lists/*"
        )
    if pip:
        lines.append("RUN pip install --no-cache-dir " + " ".join(pip))
    for item in items:
        for command in item.get("run", []):
            lines.append(f"RUN {command}")
    return "\n".join(lines) + "\n" + wrapper_stage(platform_image)


def l1_dockerfile(base_image: str, has_requirements: bool, platform_image: str) -> str:
    lines = [f"FROM {base_image}"]
    if has_requirements:
        lines += [
            "COPY requirements.txt /tmp/requirements.txt",
            # Wheels only: no package's setup.py runs during the build.
            "RUN pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt",
        ]
    lines.append("COPY script.py /app/script.py")
    return "\n".join(lines) + "\n" + wrapper_stage(platform_image)


def l2_dockerfile(base_image: str, has_requirements: bool, platform_image: str) -> str:
    lines = [f"FROM {base_image}", "COPY app/ /app/"]
    if has_requirements:
        lines.append("RUN pip install --no-cache-dir --only-binary=:all: -r /app/requirements.txt")
    return "\n".join(lines) + "\n" + wrapper_stage(platform_image)


def l3_wrapper_dockerfile(user_image: str, platform_image: str) -> str:
    # /tmp is writable in almost every image, even for a non-root USER.
    return f"FROM {user_image}\n" + wrapper_stage(platform_image, work_dir="/tmp/platform-work")


# --- Build steps -----------------------------------------------------------------

def run(cmd, **kwargs):
    print("+ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kwargs)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read()


def load_catalog() -> dict:
    data = json.loads((HERE / "catalog.json").read_text())
    return {item["id"]: item for item in data["items"]}


def block_credential_endpoints(probe_image: str) -> None:
    """Stops build containers from reaching the credential endpoints, then
    checks it worked. Fails the build rather than run user steps with access."""
    for address in CREDENTIAL_ENDPOINTS:
        run(["iptables", "-I", "DOCKER-USER", "-d", address, "-j", "DROP"])
        run(["iptables", "-I", "INPUT", "-i", "docker0", "-d", address, "-j", "DROP"])
    probe = (
        "import socket,sys\n"
        "for host in ('169.254.170.2', '169.254.169.254'):\n"
        "    try:\n"
        "        socket.create_connection((host, 80), timeout=3); sys.exit(1)\n"
        "    except OSError:\n"
        "        pass\n"
    )
    result = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "python3", probe_image, "-c", probe]
    )
    if result.returncode != 0:
        raise RuntimeError("Credential endpoints are still reachable from build containers")


def ecr_login(image: str) -> None:
    registry = image.split("/", 1)[0]
    region = registry.split(".")[3]
    password = subprocess.run(
        ["aws", "ecr", "get-login-password", "--region", region],
        check=True, capture_output=True, text=True,
    ).stdout
    run(["docker", "login", "--username", "AWS", "--password-stdin", registry], input=password, text=True)


def docker_build(context: Path, tag: str) -> None:
    # The classic builder runs every RUN step on the docker0 bridge, which is
    # where the credential-endpoint block applies.
    env = dict(os.environ, DOCKER_BUILDKIT="0")
    run(["docker", "build", "--network", "bridge", "-t", tag, str(context)], env=env)


def package_lists(image: str) -> dict:
    """pip and dpkg package lists, read from the image with networking off."""
    lists = {}
    commands = {
        "pip-freeze.txt": "python3 -m pip freeze --all 2>/dev/null || true",
        "dpkg.txt": "dpkg-query -W -f '${Package} ${Version}\\n' 2>/dev/null || true",
    }
    for name, command in commands.items():
        result = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", command],
            capture_output=True, text=True,
        )
        lists[name] = result.stdout if result.returncode == 0 else ""
    return lists


def upload_results(results_post: dict, files: dict) -> None:
    """Uploads each file with the presigned POST (its policy allows any key
    under the build's prefix)."""
    for name, content in files.items():
        boundary = uuid.uuid4().hex
        fields = dict(results_post["fields"], key=results_post["prefix"] + name)
        body = io.BytesIO()
        for key, value in fields.items():
            body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        body.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            "Content-Type: text/plain\r\n\r\n".encode()
        )
        body.write(content.encode() + b"\r\n")
        body.write(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            results_post["url"], data=body.getvalue(), method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        urllib.request.urlopen(request, timeout=60).read()


def prepare_script_context(level: str, source: bytes, context: Path) -> bool:
    """Writes the build context for an L1/L2 script. Returns whether there
    are pip requirements to install."""
    if level == "L1":
        text = source.decode("utf-8")
        deps = pep723_dependencies(text)
        (context / "script.py").write_text(text)
        if deps:
            (context / "requirements.txt").write_text("\n".join(deps) + "\n")
        return bool(deps)

    app = context / "app"
    app.mkdir()
    safe_extract(source, app)
    req = app / "requirements.txt"
    if req.exists():
        requirements_file(req.read_text())
        return True
    return False


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        return build()
    except BuildError as e:
        (OUT / "error").write_text(str(e))
        print(f"BUILD REJECTED: {e}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as e:
        (OUT / "error").write_text(f"`{' '.join(e.cmd[:2])}` failed (exit {e.returncode}); see the build log")
        return 1
    except Exception as e:  # noqa: BLE001 - anything else is a platform fault
        (OUT / "error").write_text(f"Build failed: {e}")
        raise


def build() -> int:
    kind = os.environ["BUILD_KIND"]
    platform_image = os.environ["PLATFORM_IMAGE"]
    image = f"{os.environ['IMAGE_REPO']}:{os.environ['IMAGE_TAG']}"

    shutil.rmtree(WORK, ignore_errors=True)
    context = WORK / "context"
    context.mkdir(parents=True)

    ecr_login(platform_image)
    run(["docker", "pull", platform_image])
    block_credential_endpoints(platform_image)

    if kind == "env":
        catalog = load_catalog()
        ids = json.loads(os.environ.get("CATALOG_ITEMS", "[]"))
        unknown = [i for i in ids if i not in catalog]
        if unknown:
            raise BuildError(f"Unknown catalog items: {', '.join(unknown)}")
        dockerfile = env_dockerfile(os.environ["BASE_IMAGE"], [catalog[i] for i in ids], platform_image)
        (context / "Dockerfile").write_text(dockerfile)
        docker_build(context, image)
    else:
        level = os.environ["LEVEL"]
        source = fetch(os.environ["SOURCE_URL"])
        if level in ("L1", "L2"):
            has_reqs = prepare_script_context(level, source, context)
            make = l1_dockerfile if level == "L1" else l2_dockerfile
            (context / "Dockerfile").write_text(make(os.environ["BASE_IMAGE"], has_reqs, platform_image))
            docker_build(context, image)
        elif level == "L3":
            user_context = WORK / "user"
            user_context.mkdir()
            safe_extract(source, user_context)
            if not (user_context / "Dockerfile").is_file():
                raise BuildError("The zip has no Dockerfile at its root")
            docker_build(user_context, "user-image:latest")
            (context / "Dockerfile").write_text(l3_wrapper_dockerfile("user-image:latest", platform_image))
            docker_build(context, image)
        else:
            raise BuildError(f"Unknown level {level}")

    run(["docker", "push", image])
    digest_ref = subprocess.run(
        ["docker", "inspect", "--format", "{{index .RepoDigests 0}}", image],
        check=True, capture_output=True, text=True,
    ).stdout.strip()

    lists = package_lists(image)
    meta = {"image": digest_ref, "kind": kind, "level": os.environ.get("LEVEL")}
    upload_results(json.loads(os.environ["RESULTS_POST"]), {**lists, "meta.json": json.dumps(meta, indent=2)})

    (OUT / "image_uri").write_text(digest_ref)
    print(f"Built {digest_ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
