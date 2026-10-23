"""Scripts (modules) and environments: create, upload, validate and build.

  GET  /modules                                        list the caller's scripts
  POST /modules                                        {name, description?, runtime: cloud|local}
  GET  /modules/{moduleId}                             script + versions
  POST /modules/{moduleId}/versions                    {level?, envId?, envVersion?, originalFilename, sizeBytes, sha256}
  POST /modules/{moduleId}/versions/{version}/complete verify upload, validate, start the build
  GET  /modules/{moduleId}/versions/{version}/download presigned GET of the source
  GET  /modules/{moduleId}/versions/{version}/log      build log (last 500 lines)
  GET  /modules/{moduleId}/versions/{version}/packages pip / dpkg lists from the build
  GET  /environments                                   platform environments + the caller's
  GET  /environments/catalog                           tools that can be added
  POST /environments                                   {name, description?, base, catalogItems}
  GET  /environments/{envId}                           environment + versions
  POST /environments/{envId}/versions                  {catalogItems, fromVersion?}
  GET  /environments/{envId}/versions/{version}/log
  GET  /environments/{envId}/versions/{version}/packages

Builds run in CodeBuild with a role that has no S3 access, so everything a
build reads or writes is passed as a presigned URL.
"""
import ast
import base64
import io
import json
import os
import re
import secrets
import stat
import sys
import time
import uuid
import zipfile
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.config import Config
from botocore.exceptions import ClientError


def _s3_config():
    try:
        return Config(signature_version="s3v4", request_checksum_calculation="when_required",
                      response_checksum_validation="when_required")
    except TypeError:
        return Config(signature_version="s3v4")


REGION = os.environ.get("AWS_REGION", "us-east-2")
s3 = boto3.client("s3", region_name=REGION, config=_s3_config())
codebuild = boto3.client("codebuild")
logs = boto3.client("logs")
dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]
PROJECT = os.environ["CODEBUILD_PROJECT"]
BUILDKIT_KEY = os.environ["BUILDKIT_KEY"]
CATALOG_KEY = os.environ["CATALOG_KEY"]
MAX_SOURCE_BYTES = int(os.environ.get("MAX_SOURCE_BYTES", str(50 * 1024 * 1024)))
BUILD_URL_EXPIRES_SEC = 4 * 3600
UPLOAD_EXPIRES_SEC = 900

PLATFORM_ENVS = ("platform-base", "platform-ghidra")
DEFAULT_ENV = "platform-base"
LEVELS = ("L1", "L2", "L3")
MAX_ZIP_ENTRIES = 2000
MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024
MAX_ZIP_RATIO = 100
MAX_CATALOG_ITEMS = 20

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ENV_ID_PATTERN = re.compile(r"^(platform-[a-z]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PEP723_BLOCK = re.compile(r"(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$")
REQUIREMENT = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._, -]+\])?"
    r"\s*((===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*(,\s*(===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*)*)?"
    r"(\s*;\s*[^@]+)?$"
)

_catalog_cache = None


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class ValidationFailed(Exception):
    """The uploaded source was rejected; the message is shown to the user."""


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    params = event.get("pathParameters") or {}

    try:
        body = json.loads(event.get("body") or "{}") if method == "POST" else {}
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})
    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    table = dynamodb.Table(TABLE)
    try:
        route = (method, resource)
        if route == ("GET", "/modules"):
            return _resp(200, {"modules": _list_owned(table, user_id, "MODULE")})
        if route == ("POST", "/modules"):
            return _create_module(table, user_id, body)
        if route == ("GET", "/environments"):
            return _resp(200, {"environments": _list_environments(table, user_id)})
        if route == ("GET", "/environments/catalog"):
            return _resp(200, {"items": list(_catalog().values())})
        if route == ("POST", "/environments"):
            return _create_environment(table, user_id, body)

        if resource.startswith("/modules/{moduleId}"):
            kind, entity_id = "MODULE", _uuid(params.get("moduleId"), "moduleId")
        else:
            kind, entity_id = "ENV", _env_id(params.get("envId"))

        if resource in ("/modules/{moduleId}", "/environments/{envId}"):
            return _resp(200, _get_with_versions(table, user_id, kind, entity_id))
        if route == ("POST", "/modules/{moduleId}/versions"):
            return _create_module_version(table, user_id, entity_id, body)
        if route == ("POST", "/environments/{envId}/versions"):
            return _create_environment_version(table, user_id, entity_id, body)

        version = _version_number(params.get("version"))
        if resource.endswith("/complete"):
            return _complete_module_version(table, user_id, entity_id, version)
        if resource.endswith("/download"):
            return _download_source(table, user_id, entity_id, version)
        if resource.endswith("/log"):
            return _build_log(table, user_id, kind, entity_id, version)
        if resource.endswith("/packages"):
            return _packages(table, user_id, kind, entity_id, version)
    except RequestError as e:
        return _resp(e.status, {"error": e.message})

    return _resp(404, {"error": "Unknown route"})


# --- Modules -----------------------------------------------------------------

def _create_module(table, user_id, body):
    name = _text(body.get("name"), "name", 120)
    description = _text(body.get("description") or "", "description", 1000, required=False)
    runtime = body.get("runtime", "cloud")
    if runtime not in ("cloud", "local"):
        raise RequestError(400, "runtime must be cloud or local")

    module_id = _uuid7()
    now = _now()
    item = {
        "pk": f"MODULE#{module_id}", "sk": "METADATA", "entity": "module", "moduleId": module_id,
        "name": name, "description": description, "runtime": runtime, "latestVersion": 0,
        "createdBy": user_id, "createdAt": now, "updatedAt": now,
    }
    client.transact_write_items(TransactItems=[
        _put(item),
        _put({"pk": f"USER#{user_id}", "sk": f"MODULE#{module_id}", "entity": "user-module",
              "role": "owner", "name": name, "createdAt": now}),
        _put({"pk": f"MODULE#{module_id}", "sk": f"USER#{user_id}", "entity": "module-user", "role": "owner"}),
    ])
    return _resp(201, {"module": _public(item)})


def _create_module_version(table, user_id, module_id, body):
    module = _owned(table, user_id, "MODULE", module_id)

    filename = _text(body.get("originalFilename"), "originalFilename", 255)
    size = body.get("sizeBytes")
    if not _is_int(size) or not 0 < size <= MAX_SOURCE_BYTES:
        raise RequestError(400, f"sizeBytes must be between 1 and {MAX_SOURCE_BYTES}")
    sha256 = body.get("sha256")
    if not isinstance(sha256, str) or not SHA256_PATTERN.match(sha256):
        raise RequestError(400, "sha256 must be a 64-character lowercase hex string")

    fields = {}
    if module["runtime"] == "cloud":
        level = body.get("level")
        if level not in LEVELS:
            raise RequestError(400, "level must be L1, L2 or L3")
        expected_ext = ".py" if level == "L1" else ".zip"
        if not filename.lower().endswith(expected_ext):
            raise RequestError(400, f"{level} uploads must be a {expected_ext} file")
        fields["level"] = level
        if level in ("L1", "L2"):
            env_id = body.get("envId") or DEFAULT_ENV
            env_version = _ready_env_version(table, user_id, _env_id(env_id), body.get("envVersion"))
            fields.update({
                "envId": env_id, "envVersion": int(env_version["version"]),
                "baseImage": env_version["imageUri"],
            })

    n = int(table.update_item(
        Key={"pk": f"MODULE#{module_id}", "sk": "METADATA"},
        UpdateExpression="ADD latestVersion :one SET updatedAt = :now",
        ExpressionAttributeValues={":one": 1, ":now": _now()},
        ReturnValues="UPDATED_NEW",
    )["Attributes"]["latestVersion"])

    attempt = str(uuid.uuid4())
    source_key = f"scripts/{module_id}/{n}/{attempt}"
    now = _now()
    item = {
        "pk": f"MODULE#{module_id}", "sk": f"VERSION#{n:04d}", "entity": "module-version",
        "moduleId": module_id, "version": n, "runtime": module["runtime"], **fields,
        "originalFilename": filename, "sizeBytes": size, "sha256": sha256, "sourceKey": source_key,
        "status": "pending", "statusUpdatedAt": now, "createdBy": user_id, "createdAt": now,
    }
    table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")

    checksum = base64.b64encode(bytes.fromhex(sha256)).decode()
    upload = s3.generate_presigned_post(
        Bucket=BUCKET, Key=source_key,
        Fields={"Content-Type": "application/octet-stream", "x-amz-checksum-algorithm": "SHA256",
                "x-amz-checksum-sha256": checksum},
        Conditions=[{"Content-Type": "application/octet-stream"}, {"x-amz-checksum-algorithm": "SHA256"},
                    {"x-amz-checksum-sha256": checksum}, ["content-length-range", size, size]],
        ExpiresIn=UPLOAD_EXPIRES_SEC,
    )
    return _resp(201, {"version": _public(item), "upload": {"url": upload["url"], "fields": upload["fields"]}})


def _complete_module_version(table, user_id, module_id, n):
    _owned(table, user_id, "MODULE", module_id)
    key = {"pk": f"MODULE#{module_id}", "sk": f"VERSION#{n:04d}"}
    item = table.get_item(Key=key).get("Item")
    if item is None:
        raise RequestError(404, "Version not found")
    if item["status"] != "pending":
        return _resp(200, {"version": _public(item)})

    try:
        head = s3.head_object(Bucket=BUCKET, Key=item["sourceKey"], ChecksumMode="ENABLED")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "403"):
            raise RequestError(409, "Uploaded file not found yet; retry once the upload has finished")
        raise
    expected = base64.b64encode(bytes.fromhex(item["sha256"])).decode()
    if head["ContentLength"] != int(item["sizeBytes"]) or head.get("ChecksumSHA256") != expected:
        return _resp(422, {"version": _public(_set_status(table, key, "rejected", "Upload does not match the declared size and SHA-256"))})

    if item["runtime"] == "local":
        return _resp(200, {"version": _public(_set_status(table, key, "ready", None))})

    source = s3.get_object(Bucket=BUCKET, Key=item["sourceKey"])["Body"].read()
    try:
        command = validate_source(item["level"], source)
    except ValidationFailed as e:
        return _resp(200, {"version": _public(_set_status(table, key, "rejected", str(e)))})

    table.update_item(
        Key=key, UpdateExpression="SET command = :c",
        ExpressionAttributeValues={":c": command},
    )
    build_id = _start_build_or_fail(
        table, key, user_id,
        target=f"MODULE#{module_id}/VERSION#{n:04d}",
        image_tag=f"mod-{module_id}-{n}",
        results_prefix=f"builds/modules/{module_id}/{n}/",
        variables={
            "BUILD_KIND": "script",
            "LEVEL": item["level"],
            "SOURCE_URL": _presign_get(item["sourceKey"], BUILD_URL_EXPIRES_SEC),
            "BASE_IMAGE": item.get("baseImage", ""),
        },
    )
    updated = table.update_item(
        Key=key,
        UpdateExpression="SET #st = :b, buildId = :id, statusUpdatedAt = :now, freezeKey = :fk",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":b": "building", ":id": build_id, ":now": _now(),
                                   ":fk": f"builds/modules/{module_id}/{n}/"},
        ReturnValues="ALL_NEW",
    )["Attributes"]
    return _resp(200, {"version": _public(updated)})


def _download_source(table, user_id, module_id, n):
    _owned(table, user_id, "MODULE", module_id)
    item = table.get_item(Key={"pk": f"MODULE#{module_id}", "sk": f"VERSION#{n:04d}"}).get("Item")
    if item is None or item["status"] in ("pending",):
        raise RequestError(404, "Version not found or not uploaded")
    filename = re.sub(r"[^A-Za-z0-9._ -]", "_", item.get("originalFilename") or "source")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": item["sourceKey"],
                "ResponseContentDisposition": f'attachment; filename="{filename}"'},
        ExpiresIn=300,
    )
    return _resp(200, {"url": url})


# --- Validation (also used by tests) -------------------------------------------

def validate_source(level, source):
    """Checks an uploaded source and returns the command the launcher runs.
    Raises ValidationFailed with a message for the user."""
    if level == "L1":
        try:
            text = source.decode("utf-8")
        except UnicodeDecodeError:
            raise ValidationFailed("The script is not valid UTF-8 text")
        _check_python(text, "script.py")
        pep723_dependencies(text)
        return ["python3", "-m", "platform_sdk.driver", "/app/script.py"]

    archive = _open_zip(source)
    names = {info.filename for info in archive.infolist()}
    config = {}
    if "platform.json" in names:
        try:
            config = json.loads(archive.read("platform.json"))
        except (ValueError, UnicodeDecodeError):
            raise ValidationFailed("platform.json is not valid JSON")
        if not isinstance(config, dict):
            raise ValidationFailed("platform.json must be a JSON object")

    if level == "L2":
        entry = config.get("entrypoint", "main.py")
        if not isinstance(entry, str) or not re.match(r"^[A-Za-z0-9_./-]+\.py$", entry) or ".." in entry:
            raise ValidationFailed("platform.json entrypoint must be a relative .py path")
        if entry not in names:
            raise ValidationFailed(f"The zip has no {entry} at its root" if entry == "main.py" else f"{entry} is not in the zip")
        _check_python(archive.read(entry).decode("utf-8", errors="replace"), entry)
        if "requirements.txt" in names:
            requirements_file(archive.read("requirements.txt").decode("utf-8", errors="replace"))
        shadowing = sorted({
            top for top in (n.split("/", 1)[0].removesuffix(".py") for n in names)
            if top in sys.stdlib_module_names
        })
        if shadowing:
            raise ValidationFailed(
                f"Files would hide Python standard library modules: {', '.join(shadowing)}. Rename them."
            )
        return ["python3", "-m", "platform_sdk.driver", f"/app/{entry}"]

    # L3
    if "Dockerfile" not in names:
        raise ValidationFailed("The zip has no Dockerfile at its root")
    command = config.get("command")
    if (not isinstance(command, list) or not command or len(command) > 50
            or not all(isinstance(c, str) and 0 < len(c) <= 1000 for c in command)):
        raise ValidationFailed('platform.json needs "command": a list of strings, e.g. ["python3", "/app/main.py"]')
    return command


def _open_zip(source):
    try:
        archive = zipfile.ZipFile(io.BytesIO(source))
    except zipfile.BadZipFile:
        raise ValidationFailed("The upload is not a valid zip file")
    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise ValidationFailed(f"The zip has more than {MAX_ZIP_ENTRIES} entries")
    total = 0
    for info in infos:
        name = info.filename
        if name.startswith("/") or "\\" in name or ".." in name.split("/"):
            raise ValidationFailed(f"Unsafe path in zip: {name}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValidationFailed(f"Links are not allowed in the zip: {name}")
        if info.compress_size and info.file_size / info.compress_size > MAX_ZIP_RATIO:
            raise ValidationFailed(f"{name} is compressed suspiciously well (possible zip bomb)")
        total += info.file_size
    if total > MAX_ZIP_TOTAL_BYTES:
        raise ValidationFailed(f"The zip expands to more than {MAX_ZIP_TOTAL_BYTES // (1024 * 1024)} MB")
    return archive


def _check_python(text, name):
    try:
        tree = ast.parse(text, filename=name)
    except SyntaxError as e:
        raise ValidationFailed(f"{name} line {e.lineno}: {e.msg}")
    if not any(isinstance(node, ast.FunctionDef) and node.name == "run" for node in tree.body):
        raise ValidationFailed(f"{name} must define run(ctx) at the top level")


def pep723_dependencies(source):
    blocks = [m for m in PEP723_BLOCK.finditer(source) if m.group("type") == "script"]
    if len(blocks) > 1:
        raise ValidationFailed("More than one `# /// script` block")
    if not blocks:
        return []
    content = "".join(
        line[2:] if line.startswith("# ") else line[1:]
        for line in blocks[0].group("content").splitlines(keepends=True)
    )
    import tomllib
    try:
        deps = tomllib.loads(content).get("dependencies", [])
    except tomllib.TOMLDecodeError as e:
        raise ValidationFailed(f"The `# /// script` block is not valid TOML: {e}")
    if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
        raise ValidationFailed("`dependencies` must be a list of strings")
    return [_check_requirement(d) for d in deps]


def requirements_file(text):
    return [_check_requirement(line.split("#", 1)[0].strip())
            for line in text.splitlines() if line.split("#", 1)[0].strip()]


def _check_requirement(req):
    req = req.strip()
    if not REQUIREMENT.match(req) or "://" in req or "@" in req:
        raise ValidationFailed(
            f"Unsupported dependency {req!r}: use a package name and version only (no URLs, paths or options)"
        )
    return req


# --- Environments --------------------------------------------------------------

def _list_environments(table, user_id):
    platform = table.query(
        KeyConditionExpression=Key("pk").eq("PLATFORM") & Key("sk").begins_with("ENV#")
    ).get("Items", [])
    ids = [row["sk"][4:] for row in platform]
    own = _link_ids(table, f"USER#{user_id}", "ENV#")
    items = _batch_get([{"pk": f"ENV#{i}", "sk": "METADATA"} for i in ids + own])
    by_id = {i["envId"]: i for i in items}
    result = []
    for env_id in ids + own:
        if env_id in by_id:
            result.append({**_public(by_id[env_id]), "platform": env_id in ids})
    return result


def _create_environment(table, user_id, body):
    name = _text(body.get("name"), "name", 120)
    description = _text(body.get("description") or "", "description", 1000, required=False)
    base = body.get("base") or DEFAULT_ENV
    if base not in PLATFORM_ENVS:
        raise RequestError(400, f"base must be one of: {', '.join(PLATFORM_ENVS)}")
    items = _catalog_items(body.get("catalogItems"))
    parent = _ready_env_version(table, user_id, base, None)

    env_id = _uuid7()
    now = _now()
    meta = {
        "pk": f"ENV#{env_id}", "sk": "METADATA", "entity": "env", "envId": env_id, "name": name,
        "description": description, "base": base, "latestVersion": 1,
        "createdBy": user_id, "createdAt": now, "updatedAt": now,
    }
    version = _env_version_item(env_id, 1, user_id, parent["imageUri"], items, None, f"{base} v{parent['version']}")
    client.transact_write_items(TransactItems=[
        _put(meta),
        _put(version),
        _put({"pk": f"USER#{user_id}", "sk": f"ENV#{env_id}", "entity": "user-env", "role": "owner",
              "name": name, "createdAt": now}),
        _put({"pk": f"ENV#{env_id}", "sk": f"USER#{user_id}", "entity": "env-user", "role": "owner"}),
    ])
    version = _start_env_build(table, user_id, env_id, 1, parent["imageUri"], items)
    return _resp(201, {"environment": _public(meta), "version": _public(version)})


def _create_environment_version(table, user_id, env_id, body):
    if env_id in PLATFORM_ENVS:
        raise RequestError(403, "Platform environments can't be changed; create your own from them")
    _owned(table, user_id, "ENV", env_id)
    additions = _catalog_items(body.get("catalogItems"))
    parent = _ready_env_version(table, user_id, env_id, body.get("fromVersion"))
    combined = sorted(set(parent.get("catalogItems") or []) | set(additions))

    n = int(table.update_item(
        Key={"pk": f"ENV#{env_id}", "sk": "METADATA"},
        UpdateExpression="ADD latestVersion :one SET updatedAt = :now",
        ExpressionAttributeValues={":one": 1, ":now": _now()},
        ReturnValues="UPDATED_NEW",
    )["Attributes"]["latestVersion"])
    item = _env_version_item(env_id, n, user_id, parent["imageUri"], combined, int(parent["version"]), None)
    table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
    # Only the additions are installed: the parent image already has the rest.
    version = _start_env_build(table, user_id, env_id, n, parent["imageUri"], additions)
    return _resp(201, {"version": _public(version)})


def _env_version_item(env_id, n, user_id, base_image, items, parent_version, based_on):
    now = _now()
    item = {
        "pk": f"ENV#{env_id}", "sk": f"VERSION#{n:04d}", "entity": "env-version", "envId": env_id,
        "version": n, "baseImage": base_image, "catalogItems": items, "packageMode": "offline",
        "status": "pending", "statusUpdatedAt": now, "createdBy": user_id, "createdAt": now,
    }
    if parent_version is not None:
        item["parentVersion"] = parent_version
    if based_on:
        item["basedOn"] = based_on
    return item


def _start_env_build(table, user_id, env_id, n, base_image, items):
    build_id = _start_build_or_fail(
        table, {"pk": f"ENV#{env_id}", "sk": f"VERSION#{n:04d}"}, user_id,
        target=f"ENV#{env_id}/VERSION#{n:04d}",
        image_tag=f"env-{env_id}-{n}",
        results_prefix=f"builds/envs/{env_id}/{n}/",
        variables={"BUILD_KIND": "env", "BASE_IMAGE": base_image, "CATALOG_ITEMS": json.dumps(items)},
    )
    return table.update_item(
        Key={"pk": f"ENV#{env_id}", "sk": f"VERSION#{n:04d}"},
        UpdateExpression="SET #st = :b, buildId = :id, statusUpdatedAt = :now, freezeKey = :fk",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":b": "building", ":id": build_id, ":now": _now(),
                                   ":fk": f"builds/envs/{env_id}/{n}/"},
        ReturnValues="ALL_NEW",
    )["Attributes"]


def _ready_env_version(table, user_id, env_id, version):
    """An environment version the caller may build on: a platform one, or
    their own. Defaults to the newest ready version."""
    if env_id not in PLATFORM_ENVS:
        _owned(table, user_id, "ENV", env_id)
    if version is not None:
        if not _is_int(version) or version < 1:
            raise RequestError(400, "envVersion must be a positive integer")
        item = table.get_item(Key={"pk": f"ENV#{env_id}", "sk": f"VERSION#{version:04d}"}).get("Item")
        if item is None or item.get("status") != "ready":
            raise RequestError(409, f"Environment version {version} is not ready")
        return item
    rows = table.query(
        KeyConditionExpression=Key("pk").eq(f"ENV#{env_id}") & Key("sk").begins_with("VERSION#"),
        ScanIndexForward=False,
    ).get("Items", [])
    for row in rows:
        if row.get("status") == "ready":
            return row
    raise RequestError(409, f"Environment {env_id} has no ready version yet")


def _catalog_items(raw):
    if raw is None:
        return []
    catalog = _catalog()
    if not isinstance(raw, list) or len(raw) > MAX_CATALOG_ITEMS or not all(isinstance(i, str) for i in raw):
        raise RequestError(400, f"catalogItems must be a list of at most {MAX_CATALOG_ITEMS} ids")
    unknown = [i for i in raw if i not in catalog]
    if unknown:
        raise RequestError(400, f"Unknown catalog items: {', '.join(unknown)}")
    return sorted(set(raw))


def _catalog():
    global _catalog_cache
    if _catalog_cache is None:
        data = json.loads(s3.get_object(Bucket=BUCKET, Key=CATALOG_KEY)["Body"].read())
        _catalog_cache = {item["id"]: item for item in data["items"]}
    return _catalog_cache


# --- Builds --------------------------------------------------------------------

def _platform_image():
    table = dynamodb.Table(TABLE)
    rows = table.query(
        KeyConditionExpression=Key("pk").eq("ENV#platform-base") & Key("sk").begins_with("VERSION#"),
        ScanIndexForward=False,
    ).get("Items", [])
    for row in rows:
        if row.get("status") == "ready" and row.get("imageUri"):
            return row["imageUri"]
    raise RequestError(503, "The platform base image hasn't been published yet")


def _start_build(user_id, target, image_tag, results_prefix, variables):
    results = s3.generate_presigned_post(
        Bucket=BUCKET, Key=results_prefix + "${filename}",
        Conditions=[["content-length-range", 0, 50 * 1024 * 1024]],
        ExpiresIn=BUILD_URL_EXPIRES_SEC,
    )
    env = {
        **variables,
        "PLATFORM_IMAGE": _platform_image(),
        "IMAGE_TAG": image_tag,
        "BUILDKIT_URL": _presign_get(BUILDKIT_KEY, BUILD_URL_EXPIRES_SEC),
        "RESULTS_POST": json.dumps({"url": results["url"], "fields": results["fields"], "prefix": results_prefix}),
        # Read back by builds-events and usage-meter.
        "TARGET": target,
        "OWNER_ID": user_id,
    }
    response = codebuild.start_build(
        projectName=PROJECT,
        environmentVariablesOverride=[{"name": k, "value": str(v), "type": "PLAINTEXT"} for k, v in env.items()],
    )
    return response["build"]["id"]


def _start_build_or_fail(table, key, user_id, **kwargs):
    """Starts the build, or marks the version build_failed if CodeBuild
    refuses (quota, throttling), so it never sits in pending."""
    try:
        return _start_build(user_id, **kwargs)
    except (ClientError, RequestError) as e:
        message = e.message if isinstance(e, RequestError) else e.response["Error"].get("Message", "unknown error")
        _set_status(table, key, "build_failed", f"The build could not be started: {message}")
        raise RequestError(503, f"The build could not be started: {message}")


def _build_log(table, user_id, kind, entity_id, n):
    item = _version(table, user_id, kind, entity_id, n)
    if not item.get("buildId"):
        return _resp(200, {"lines": []})
    builds = codebuild.batch_get_builds(ids=[item["buildId"]]).get("builds", [])
    info = (builds[0].get("logs") or {}) if builds else {}
    if not info.get("groupName") or not info.get("streamName"):
        return _resp(200, {"lines": [], "note": "The build hasn't started logging yet"})
    events = logs.get_log_events(
        logGroupName=info["groupName"], logStreamName=info["streamName"], limit=500, startFromHead=False,
    ).get("events", [])
    return _resp(200, {"lines": [e["message"].rstrip("\n") for e in events]})


def _packages(table, user_id, kind, entity_id, n):
    item = _version(table, user_id, kind, entity_id, n)
    prefix = item.get("freezeKey")
    result = {}
    for name in ("pip-freeze.txt", "dpkg.txt"):
        try:
            obj = s3.get_object(Bucket=BUCKET, Key=f"{prefix}{name}", Range="bytes=0-1048575")
            result[name.split(".")[0]] = obj["Body"].read().decode("utf-8", errors="replace")
        except (ClientError, TypeError):
            result[name.split(".")[0]] = None
    return _resp(200, {"pip": result.get("pip-freeze"), "dpkg": result.get("dpkg")})


# --- Shared lookups ----------------------------------------------------------------

def _get_with_versions(table, user_id, kind, entity_id):
    if not (kind == "ENV" and entity_id in PLATFORM_ENVS):
        _owned(table, user_id, kind, entity_id)
    meta = table.get_item(Key={"pk": f"{kind}#{entity_id}", "sk": "METADATA"}).get("Item")
    if meta is None:
        raise RequestError(404, "Not found")
    versions = table.query(
        KeyConditionExpression=Key("pk").eq(f"{kind}#{entity_id}") & Key("sk").begins_with("VERSION#"),
        ScanIndexForward=False,
    ).get("Items", [])
    key = "module" if kind == "MODULE" else "environment"
    return {key: _public(meta), "versions": [_public(v) for v in versions]}


def _version(table, user_id, kind, entity_id, n):
    if not (kind == "ENV" and entity_id in PLATFORM_ENVS):
        _owned(table, user_id, kind, entity_id)
    item = table.get_item(Key={"pk": f"{kind}#{entity_id}", "sk": f"VERSION#{n:04d}"}).get("Item")
    if item is None:
        raise RequestError(404, "Version not found")
    return item


def _owned(table, user_id, kind, entity_id):
    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"{kind}#{entity_id}"}).get("Item")
    if link is None or link.get("role") != "owner":
        raise RequestError(404, "Not found")
    item = table.get_item(Key={"pk": f"{kind}#{entity_id}", "sk": "METADATA"}).get("Item")
    if item is None:
        raise RequestError(404, "Not found")
    return item


def _list_owned(table, user_id, kind):
    ids = _link_ids(table, f"USER#{user_id}", f"{kind}#")
    items = _batch_get([{"pk": f"{kind}#{i}", "sk": "METADATA"} for i in ids])
    order = {i: n for n, i in enumerate(ids)}
    id_field = "moduleId" if kind == "MODULE" else "envId"
    return [_public(i) for i in sorted(items, key=lambda i: order.get(i[id_field], 0))]


def _link_ids(table, pk, prefix):
    ids, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
                       "ScanIndexForward": False}
    while True:
        page = table.query(**kwargs)
        ids += [row["sk"][len(prefix):] for row in page.get("Items", [])]
        if "LastEvaluatedKey" not in page:
            return ids
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _batch_get(keys):
    items = []
    for start in range(0, len(keys), 100):
        request = {TABLE: {"Keys": keys[start:start + 100]}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    return items


def _set_status(table, key, status, reason):
    update = "SET #st = :s, statusUpdatedAt = :now"
    values = {":s": status, ":now": _now()}
    if reason:
        update += ", statusReason = :r"
        values[":r"] = reason
    return table.update_item(Key=key, UpdateExpression=update, ExpressionAttributeNames={"#st": "status"},
                             ExpressionAttributeValues=values, ReturnValues="ALL_NEW")["Attributes"]


# --- Helpers ---------------------------------------------------------------------

HIDDEN_FIELDS = {"pk", "sk", "entity", "sourceKey", "freezeKey", "createdBy", "buildId"}


def _public(item):
    out = {}
    for k, v in item.items():
        if k in HIDDEN_FIELDS:
            continue
        if isinstance(v, set):
            v = sorted(v)
        elif isinstance(v, Decimal):
            v = int(v) if v == int(v) else float(v)
        out[k] = v
    return out


def _presign_get(key, expires):
    return s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=expires)


def _text(value, name, max_len, required=True):
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise RequestError(400, f"{name} is required")
        return ""
    if not isinstance(value, str) or len(value.strip()) > max_len or any(ord(c) < 0x20 and c not in "\n\t" for c in value):
        raise RequestError(400, f"{name} is invalid (max {max_len} characters)")
    return value.strip()


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.match(value):
        raise RequestError(400, f"{name} is invalid")
    return value


def _env_id(value):
    if not isinstance(value, str) or not ENV_ID_PATTERN.match(value):
        raise RequestError(400, "envId is invalid")
    return value


def _version_number(value):
    if not isinstance(value, str) or not value.isdigit() or not 0 < int(value) < 10000:
        raise RequestError(400, "version is invalid")
    return int(value)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _uuid7():
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _put(item):
    return {"Put": {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk)"}}


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body, default=str),
    }
