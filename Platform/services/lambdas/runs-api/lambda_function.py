"""Runs: estimate, start, list, inspect and cancel bulk script runs.

  POST /runs/estimate                   preview a run: matched files, work units, cost, budget
  POST /runs                            start it
  GET  /runs                            the caller's runs, newest first
  GET  /runs/{runId}                    run + job summary + failed work units
  GET  /runs/{runId}/children/{index}/log   a job's log (last 1000 lines)
  POST /runs/{runId}/cancel

Request body for estimate/start:
  {
    "moduleId": "...", "version": 3,                      # version optional: newest ready
    "inputs": {"batchId": "..."} | {"deviceId": "...", "type": "pcap"} | {"runId": "..."}
              | {"artifactIds": [...]} | {"type": "log", "tag": "day-1"},
    "mode": "map" | "chunk" | "all" | "groupBy",
    "chunkSize": 10,                                      # chunk
    "groupBy": {"by": "folder"|"stem"|"regex"|"tag", "depth": 0, "ignoreCase": false,
                "pattern": "(\\d+)", "tagPrefix": "pair:",
                "requireTypes": ["log", "pcap"], "includeIncomplete": false},
    "unitsPerJob": 1,
    "class": "economy" | "standard" | "heavy", "size": "S" | "M" | "L" | "XL",
    "timeoutMinutes": 30, "name": "optional run name"
  }
"""
import hashlib
import json
import os
import re
import secrets
import time
import uuid
import boto3
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

batch = boto3.client("batch")
logs = boto3.client("logs")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
QUEUES = json.loads(os.environ["QUEUES"])  # {"economy": arn, "standard": arn, "heavy": arn?}
MANIFEST_URL = os.environ["MANIFEST_URL"]
PRICING = json.loads(os.environ["PRICING"])
RUN_LOG_GROUP = os.environ["RUN_LOG_GROUP"]
DEFAULT_MONTHLY_LIMIT = Decimal(os.environ.get("DEFAULT_MONTHLY_LIMIT", "25"))
HEAVY_ENABLED = os.environ.get("HEAVY_ENABLED", "false") == "true"
MAX_INPUTS = int(os.environ.get("MAX_INPUTS", "2000"))
MAX_CHILDREN = int(os.environ.get("MAX_CHILDREN", "10000"))
MAX_FILTER_SCAN = 20000

SIZES = {
    "fargate": {"S": (1, 2048), "M": (2, 8192), "L": (4, 16384), "XL": (8, 32768)},
    # Sized to fill m6i.2xlarge .. m6i.16xlarge (less ECS's reserved memory),
    # so each Heavy job gets an instance to itself.
    "ec2": {"S": (8, 30720), "M": (16, 61440), "L": (32, 124928), "XL": (64, 250880)},
}
CLASSES = {
    # class: (size table, rate used for the maximum/hold, rate used for the expected cost)
    "economy": ("fargate", "fargate", "fargateSpot"),
    "standard": ("fargate", "fargate", "fargate"),
    "heavy": ("ec2", "ec2", "ec2"),
}
MODES = ("map", "chunk", "all", "groupBy")
ARTIFACT_TYPES = {"firmware", "pcap", "log", "binary", "other"}
TERMINAL = {"completed", "failed", "cancelled", "stopped"}

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CENT = Decimal("0.000001")


class RequestError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details or {}


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    params = event.get("pathParameters") or {}
    table = dynamodb.Table(TABLE)

    try:
        body = json.loads(event.get("body") or "{}") if method == "POST" else {}
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})
    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    try:
        if (method, resource) == ("POST", "/runs/estimate"):
            plan = _plan(table, user_id, body)
            return _resp(200, _estimate_view(table, user_id, plan))
        if (method, resource) == ("POST", "/runs"):
            return _start(table, user_id, body)
        if (method, resource) == ("GET", "/runs"):
            return _resp(200, {"runs": _list_runs(table, user_id)})

        run_id = _uuid(params.get("runId"), "runId")
        run = _owned_run(table, user_id, run_id)
        if resource == "/runs/{runId}":
            return _resp(200, _run_detail(table, run))
        if resource == "/runs/{runId}/cancel":
            return _cancel(table, run)
        if resource == "/runs/{runId}/children/{index}/log":
            return _child_log(table, run, params.get("index"))
    except RequestError as e:
        return _resp(e.status, {"error": e.message, **e.details})

    return _resp(404, {"error": "Unknown route"})


# --- Planning (shared by estimate and start) --------------------------------------

def _plan(table, user_id, body):
    module_id = _uuid(body.get("moduleId"), "moduleId")
    if table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"MODULE#{module_id}"}).get("Item") is None:
        raise RequestError(404, "Script not found")
    module = table.get_item(Key={"pk": f"MODULE#{module_id}", "sk": "METADATA"}).get("Item")
    if module is None or module.get("runtime") != "cloud":
        raise RequestError(400, "Only cloud scripts can be run")
    version = _module_version(table, module_id, body.get("version"))

    run_class = body.get("class", "standard")
    if run_class not in CLASSES:
        raise RequestError(400, "class must be economy, standard or heavy")
    size = body.get("size", "S")
    size_table, max_rate_name, expected_rate_name = CLASSES[run_class]
    if size not in SIZES[size_table]:
        raise RequestError(400, "size must be S, M, L or XL")
    if run_class == "heavy" and ("heavy" not in QUEUES or not HEAVY_ENABLED or not version.get("heavyJobDefinitionArn")):
        raise RequestError(400, "The Heavy class is not enabled on this platform")
    timeout = body.get("timeoutMinutes", 30)
    if not _is_int(timeout) or not 1 <= timeout <= 360:
        raise RequestError(400, "timeoutMinutes must be between 1 and 360")

    artifacts, source = _resolve_inputs(table, user_id, body.get("inputs"))
    ready = [a for a in artifacts if a.get("status") == "ready"]
    not_ready = [a for a in artifacts if a.get("status") != "ready"]
    if len(ready) > MAX_INPUTS:
        raise RequestError(400, f"{len(ready)} files matched; a run can take at most {MAX_INPUTS}. Narrow the selection or split the run.")

    units, grouping = _make_units(ready, body)
    units_per_job = body.get("unitsPerJob", 1)
    if not _is_int(units_per_job) or not 1 <= units_per_job <= 1000:
        raise RequestError(400, "unitsPerJob must be between 1 and 1000")
    children = [units[i:i + units_per_job] for i in range(0, len(units), units_per_job)]
    if len(children) > MAX_CHILDREN:
        raise RequestError(400, f"{len(children)} jobs exceed the limit of {MAX_CHILDREN}; raise unitsPerJob")

    vcpu, memory = SIZES[size_table][size]
    max_rate = _hourly_rate(max_rate_name, vcpu, memory)
    expected_rate = _hourly_rate(expected_rate_name, vcpu, memory)
    timeout_sec = timeout * 60
    max_cost = _money(Decimal(len(children)) * Decimal(timeout_sec) / 3600 * max_rate)
    expected = _expected_cost(table, module_id, children, expected_rate)

    return {
        "module": module, "version": version, "source": source, "mode": body.get("mode", "map"),
        "grouping": grouping, "unitsPerJob": units_per_job, "class": run_class, "size": size,
        "vcpu": vcpu, "memory": memory, "timeoutSec": timeout_sec, "ready": ready, "notReady": not_ready,
        "units": units, "children": children, "maxCost": max_cost, "expectedCost": expected,
        "name": (body.get("name") or f"{module['name']} v{int(version['version'])}")[:120],
    }


def _module_version(table, module_id, requested):
    if requested is not None:
        if not _is_int(requested) or requested < 1:
            raise RequestError(400, "version must be a positive integer")
        item = table.get_item(Key={"pk": f"MODULE#{module_id}", "sk": f"VERSION#{requested:04d}"}).get("Item")
        if item is None or item.get("status") != "ready":
            raise RequestError(409, f"Version {requested} is not ready")
        return item
    rows = table.query(
        KeyConditionExpression=Key("pk").eq(f"MODULE#{module_id}") & Key("sk").begins_with("VERSION#"),
        ScanIndexForward=False,
    ).get("Items", [])
    for row in rows:
        if row.get("status") == "ready":
            return row
    raise RequestError(409, "This script has no ready version yet")


def _resolve_inputs(table, user_id, inputs):
    """Returns (artifacts, source description). Only the caller's artifacts
    are ever returned, whichever way they were selected."""
    if not isinstance(inputs, dict):
        raise RequestError(400, "inputs is required")
    sources = [k for k in ("batchId", "deviceId", "runId", "artifactIds") if inputs.get(k)]
    if len(sources) > 1:
        raise RequestError(400, "Choose one input source: batchId, deviceId, runId, artifactIds, or a type/tag filter")
    artifact_type = inputs.get("type")
    if artifact_type is not None and artifact_type not in ARTIFACT_TYPES:
        raise RequestError(400, "type is invalid")
    tag = inputs.get("tag")

    if inputs.get("batchId"):
        batch_id = _uuid(inputs["batchId"], "batchId")
        _require_link(table, user_id, f"BATCH#{batch_id}", "Upload batch not found")
        ids = _link_ids(table, f"BATCH#{batch_id}", "ARTIFACT#")
        source = {"batchId": batch_id}
    elif inputs.get("deviceId"):
        device_id = _uuid(inputs["deviceId"], "deviceId")
        _require_link(table, user_id, f"DEVICE#{device_id}", "Device not found")
        prefix = f"ARTIFACT#{artifact_type}#" if artifact_type else "ARTIFACT#"
        ids = _link_ids(table, f"DEVICE#{device_id}", prefix)
        source = {"deviceId": device_id, **({"type": artifact_type} if artifact_type else {})}
    elif inputs.get("runId"):
        run_id = _uuid(inputs["runId"], "runId")
        _require_link(table, user_id, f"RUN#{run_id}", "Run not found")
        ids = _link_ids(table, f"RUN#{run_id}", "ARTIFACT#", relation="output")
        source = {"runId": run_id}
    elif inputs.get("artifactIds"):
        raw = inputs["artifactIds"]
        if not isinstance(raw, list) or len(raw) > MAX_INPUTS:
            raise RequestError(400, f"artifactIds must be a list of at most {MAX_INPUTS} ids")
        ids = list(dict.fromkeys(_uuid(a, "artifactIds") for a in raw))
        source = {"artifactIds": len(ids)}
    else:
        ids = _link_ids(table, f"USER#{user_id}", "ARTIFACT#", limit=MAX_FILTER_SCAN)
        source = {k: v for k, v in (("type", artifact_type), ("tag", tag)) if v} or {"all": True}

    items = _batch_get([{"pk": f"ARTIFACT#{a}", "sk": "METADATA"} for a in ids])
    # Runs aren't workspace-aware yet: a workspace artifact is never an input,
    # even one the caller uploaded (createdBy alone must not outlive their
    # membership, and the manifest would hand out download URLs).
    items = [i for i in items if i.get("createdBy") == user_id and "workspaceId" not in i]
    if artifact_type:
        items = [i for i in items if i.get("type") == artifact_type]
    if tag:
        items = [i for i in items if tag in (i.get("tags") or set())]
    order = {a: n for n, a in enumerate(ids)}
    items.sort(key=lambda i: (i.get("originalFilename") or i.get("name") or "", order.get(i["artifactId"], 0)))
    return items, source


def _make_units(artifacts, body):
    """Splits the files into work units. Returns (units, grouping report)."""
    mode = body.get("mode", "map")
    if mode not in MODES:
        raise RequestError(400, "mode must be map, chunk, all or groupBy")
    report = {"unmatched": [], "incomplete": [], "duplicates": 0}

    if mode == "map":
        groups = [(a.get("originalFilename") or a["name"], [a]) for a in artifacts]
    elif mode == "chunk":
        size = body.get("chunkSize", 10)
        if not _is_int(size) or not 1 <= size <= MAX_INPUTS:
            raise RequestError(400, "chunkSize must be a positive integer")
        groups = [(f"chunk-{i // size + 1}", artifacts[i:i + size]) for i in range(0, len(artifacts), size)]
    elif mode == "all":
        groups = [("all", artifacts)] if artifacts else []
    else:
        groups = _group_by(artifacts, body.get("groupBy") or {}, report)

    units, seen = [], set()
    for key, members in groups:
        # A unit is identified by its content, so identical inputs are only
        # processed once and a retried job recognises finished units.
        unit_id = hashlib.sha256("\n".join(sorted(m["sha256"] for m in members)).encode()).hexdigest()
        if unit_id in seen:
            report["duplicates"] += 1
            continue
        seen.add(unit_id)
        units.append({"unitId": unit_id, "key": key[:512], "artifactIds": [m["artifactId"] for m in members]})
    return units, report


def _group_by(artifacts, options, report):
    by = options.get("by")
    if by not in ("folder", "stem", "regex", "tag"):
        raise RequestError(400, "groupBy.by must be folder, stem, regex or tag")
    require = options.get("requireTypes") or []
    if not isinstance(require, list) or not set(require) <= ARTIFACT_TYPES:
        raise RequestError(400, "groupBy.requireTypes must be a list of artifact types")
    include_incomplete = bool(options.get("includeIncomplete"))

    pattern = None
    if by == "regex":
        raw = options.get("pattern")
        if not isinstance(raw, str) or not 0 < len(raw) <= 200:
            raise RequestError(400, "groupBy.pattern is required (at most 200 characters)")
        try:
            pattern = re.compile(raw)
        except re.error as e:
            raise RequestError(400, f"groupBy.pattern is not a valid regular expression: {e}")
    depth = options.get("depth", 0)
    if not _is_int(depth) or not 0 <= depth <= 20:
        raise RequestError(400, "groupBy.depth must be between 0 and 20")
    prefix = options.get("tagPrefix", "")
    if by == "tag" and (not isinstance(prefix, str) or not prefix):
        raise RequestError(400, "groupBy.tagPrefix is required")
    ignore_case = bool(options.get("ignoreCase"))

    groups = {}
    for artifact in artifacts:
        path = artifact.get("originalFilename") or artifact.get("name") or ""
        key = group_key(path, sorted(artifact.get("tags") or []), by, depth, pattern, prefix, ignore_case)
        if key is None:
            report["unmatched"].append(path)
            continue
        groups.setdefault(key, []).append(artifact)

    result = []
    for key in sorted(groups):
        members = groups[key]
        missing = [t for t in require if not any(m.get("type") == t for m in members)]
        if missing:
            report["incomplete"].append({"key": key, "missing": missing,
                                         "files": [m.get("originalFilename") or m.get("name") for m in members]})
            if not include_incomplete:
                continue
        result.append((key, members))
    return result


def group_key(path, tags, by, depth=0, pattern=None, prefix="", ignore_case=False):
    """The key that decides which group a file joins, or None if it has none."""
    if by == "folder":
        parts = path.split("/")[:-1]
        if not parts:
            return None
        return "/".join(parts[:depth] if depth else parts)
    if by == "stem":
        base = path.rsplit("/", 1)[-1]
        stem = base.rsplit(".", 1)[0] if "." in base[1:] else base
        return stem.lower() if ignore_case else stem
    if by == "regex":
        match = pattern.search(path)
        if not match:
            return None
        return match.group(1) if match.re.groups else match.group(0)
    for tag in tags:
        if tag.startswith(prefix) and len(tag) > len(prefix):
            return tag[len(prefix):]
    return None


def _hourly_rate(name, vcpu, memory_mib):
    rates = PRICING[name]
    return Decimal(str(rates["vcpuHour"])) * vcpu + Decimal(str(rates["gbHour"])) * Decimal(memory_mib) / 1024


def _expected_cost(table, module_id, children, rate):
    """From this script's recent runs: average seconds per work unit."""
    history = table.query(
        KeyConditionExpression=Key("pk").eq(f"MODULE#{module_id}") & Key("sk").begins_with("RUN#"),
        ScanIndexForward=False, Limit=20,
    ).get("Items", [])
    samples = [(Decimal(h["unitSeconds"]), Decimal(h["unitCount"])) for h in history
               if h.get("unitCount") and h.get("unitSeconds") is not None]
    if not samples:
        return None
    per_unit = sum(s for s, _ in samples) / sum(n for _, n in samples)
    minimum = Decimal(PRICING.get("minBillSeconds", 60))
    seconds = sum(max(minimum, per_unit * len(child)) for child in children)
    return _money(seconds / 3600 * rate)


def _estimate_view(table, user_id, plan):
    budget = _budget(table, user_id)
    spent = budget["spentProvisional"] if budget.get("period") == _period() else Decimal(0)
    report = plan["grouping"]
    return {
        "source": plan["source"],
        "matched": len(plan["ready"]) + len(plan["notReady"]),
        "inputCount": len(plan["ready"]),
        "totalBytes": sum(int(a.get("sizeBytes", 0)) for a in plan["ready"]),
        "notReady": [{"artifactId": a["artifactId"], "name": a.get("name"), "status": a.get("status")}
                     for a in plan["notReady"][:50]],
        "notReadyCount": len(plan["notReady"]),
        "unitCount": len(plan["units"]),
        "childCount": len(plan["children"]),
        "sampleUnits": [{"key": u["key"], "files": len(u["artifactIds"])} for u in plan["units"][:10]],
        "unmatched": report["unmatched"][:50], "unmatchedCount": len(report["unmatched"]),
        "incomplete": report["incomplete"][:50], "incompleteCount": len(report["incomplete"]),
        "duplicates": report["duplicates"],
        "version": int(plan["version"]["version"]),
        "class": plan["class"], "size": plan["size"], "vcpu": plan["vcpu"], "memoryMiB": plan["memory"],
        "maxCost": float(plan["maxCost"]),
        "expectedCost": float(plan["expectedCost"]) if plan["expectedCost"] is not None else None,
        "budget": {
            "monthlyLimit": float(budget["monthlyLimit"]), "spent": float(spent), "held": float(budget["held"]),
            "available": float(budget["monthlyLimit"] - spent - budget["held"]),
            "heavyEnabled": bool(budget.get("heavyEnabled")),
        },
    }


# --- Start ------------------------------------------------------------------------

def _start(table, user_id, body):
    plan = _plan(table, user_id, body)
    if not plan["units"]:
        raise RequestError(400, "No ready files match this selection")
    if plan["class"] == "heavy" and not _budget(table, user_id).get("heavyEnabled"):
        raise RequestError(403, "The Heavy class is not enabled for your account")

    held = plan["maxCost"]
    _hold(table, user_id, held)

    run_id = _uuid7()
    token = secrets.token_urlsafe(32)
    now = _now()
    version = plan["version"]
    job_def = version["heavyJobDefinitionArn"] if plan["class"] == "heavy" else version["jobDefinitionArn"]
    run = {
        "pk": f"RUN#{run_id}", "sk": "METADATA", "entity": "run", "runId": run_id, "name": plan["name"],
        "moduleId": plan["module"]["moduleId"], "moduleName": plan["module"]["name"],
        "moduleVersion": int(version["version"]), "imageUri": version["imageUri"], "jobDefinitionArn": job_def,
        "inputs": plan["source"], "mode": plan["mode"], "unitsPerJob": plan["unitsPerJob"],
        "class": plan["class"], "size": plan["size"], "vcpu": plan["vcpu"], "memoryMiB": plan["memory"],
        "timeoutSec": plan["timeoutSec"], "inputCount": len(plan["ready"]), "unitCount": len(plan["units"]),
        "childCount": len(plan["children"]), "maxCost": held, "held": held, "costProvisional": Decimal(0),
        "unitsSucceeded": 0, "unitsFailed": 0, "outputCount": 0,
        "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
        "status": "pending", "statusUpdatedAt": now, "createdBy": user_id, "createdAt": now, "updatedAt": now,
    }
    if plan["expectedCost"] is not None:
        run["expectedCost"] = plan["expectedCost"]
    if plan["mode"] == "groupBy":
        run["groupBy"] = {k: v for k, v in (body.get("groupBy") or {}).items() if k != "pattern" or isinstance(v, str)}
    if plan["mode"] == "chunk":
        run["chunkSize"] = body.get("chunkSize", 10)

    try:
        table.put_item(Item=run, ConditionExpression="attribute_not_exists(pk)")
        with table.batch_writer() as writer:
            writer.put_item(Item={"pk": f"USER#{user_id}", "sk": f"RUN#{run_id}", "entity": "user-run",
                                  "role": "owner", "name": plan["name"], "createdAt": now})
            writer.put_item(Item={"pk": f"RUN#{run_id}", "sk": f"USER#{user_id}", "entity": "run-user", "role": "owner"})
            for index, units in enumerate(plan["children"]):
                writer.put_item(Item={"pk": f"RUN#{run_id}", "sk": f"CHILD#{index:05d}", "entity": "run-child",
                                      "index": index, "units": units, "status": "queued", "statusRank": 1})
            for artifact in plan["ready"]:
                aid = artifact["artifactId"]
                writer.put_item(Item={"pk": f"RUN#{run_id}", "sk": f"ARTIFACT#{aid}", "entity": "run-artifact",
                                      "relation": "input", "name": artifact.get("name")})
                writer.put_item(Item={"pk": f"ARTIFACT#{aid}", "sk": f"RUN#{run_id}", "entity": "artifact-run",
                                      "relation": "input", "name": plan["name"]})
            if "deviceId" in plan["source"]:
                did = plan["source"]["deviceId"]
                writer.put_item(Item={"pk": f"RUN#{run_id}", "sk": f"DEVICE#{did}", "entity": "run-device"})
                writer.put_item(Item={"pk": f"DEVICE#{did}", "sk": f"RUN#{run_id}", "entity": "device-run", "name": plan["name"]})

        submit = {
            "jobName": f"run-{run_id}",
            "jobQueue": QUEUES[plan["class"]],
            "jobDefinition": job_def,
            "containerOverrides": {
                "resourceRequirements": [
                    {"type": "VCPU", "value": str(plan["vcpu"])},
                    {"type": "MEMORY", "value": str(plan["memory"])},
                ],
                "environment": [
                    {"name": "RUN_ID", "value": run_id},
                    {"name": "RUN_TOKEN", "value": token},
                    {"name": "MANIFEST_URL", "value": MANIFEST_URL},
                ],
            },
            "timeout": {"attemptDurationSeconds": plan["timeoutSec"]},
            "tags": {"userId": user_id, "runId": run_id},
            "propagateTags": True,
        }
        if len(plan["children"]) > 1:
            submit["arrayProperties"] = {"size": len(plan["children"])}
        job_id = batch.submit_job(**submit)["jobId"]
    except Exception:
        _release(table, user_id, held)
        table.update_item(
            Key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
            UpdateExpression="SET #st = :f, statusReason = :r, held = :z, statusUpdatedAt = :now",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":f": "failed", ":r": "The run could not be submitted", ":z": Decimal(0), ":now": _now()},
        )
        raise

    table.put_item(Item={"pk": "ACTIVE#RUNS", "sk": f"RUN#{run_id}", "entity": "active-run",
                         "userId": user_id, "createdAt": now})
    updated = table.update_item(
        Key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
        UpdateExpression="SET batchJobId = :j, #st = :q, statusUpdatedAt = :now",
        ConditionExpression="#st = :p",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":j": job_id, ":q": "queued", ":p": "pending", ":now": _now()},
        ReturnValues="ALL_NEW",
    )["Attributes"]
    return _resp(201, {"run": _public_run(updated)})


# --- Budget ---------------------------------------------------------------------------

def _period():
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _budget(table, user_id):
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    item = table.get_item(Key=key).get("Item")
    if item is None:
        default = {**key, "entity": "budget", "monthlyLimit": DEFAULT_MONTHLY_LIMIT, "held": Decimal(0),
                   "spentProvisional": Decimal(0), "period": _period(), "heavyEnabled": False,
                   "version": 0, "updatedAt": _now()}
        try:
            table.put_item(Item=default, ConditionExpression="attribute_not_exists(pk)")
            return default
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            item = table.get_item(Key=key).get("Item")
    return item


def _hold(table, user_id, amount):
    """Reserves `amount` against the monthly budget. Optimistic: the write
    only succeeds if nobody changed the budget since it was read."""
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    for _ in range(6):
        budget = _budget(table, user_id)
        period = _period()
        spent = budget["spentProvisional"] if budget.get("period") == period else Decimal(0)
        available = budget["monthlyLimit"] - spent - budget["held"]
        if amount > available:
            raise RequestError(409, "This run's maximum cost is more than your remaining budget", {
                "maxCost": float(amount), "available": float(available),
            })
        try:
            table.update_item(
                Key=key,
                UpdateExpression="SET held = :h, spentProvisional = :s, period = :p, updatedAt = :now ADD version :one",
                ConditionExpression="version = :v",
                ExpressionAttributeValues={":h": budget["held"] + amount, ":s": spent, ":p": period,
                                           ":now": _now(), ":one": 1, ":v": budget["version"]},
            )
            return
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise RequestError(503, "Your budget is busy; try again")


def _release(table, user_id, amount):
    table.update_item(
        Key={"pk": f"USER#{user_id}", "sk": "BUDGET"},
        UpdateExpression="ADD held :neg, version :one SET updatedAt = :now",
        ExpressionAttributeValues={":neg": -amount, ":one": 1, ":now": _now()},
    )


# --- Reads and cancel --------------------------------------------------------------

def _list_runs(table, user_id):
    ids = _link_ids(table, f"USER#{user_id}", "RUN#", limit=200)
    items = _batch_get([{"pk": f"RUN#{i}", "sk": "METADATA"} for i in ids])
    return [_public_run(i) for i in sorted(items, key=lambda i: i["runId"], reverse=True)]


def _run_detail(table, run):
    run_id = run["runId"]
    children = _query_all(table, f"RUN#{run_id}", "CHILD#")
    counts = {}
    for child in children:
        counts[child.get("status", "queued")] = counts.get(child.get("status", "queued"), 0) + 1
    failed = [
        {"unitId": r["sk"][len("RESULT#"):], "key": r.get("key"), "error": r.get("error"), "exitCode": r.get("exitCode")}
        for r in _query_all(table, f"RUN#{run_id}", "RESULT#") if r.get("status") == "failed"
    ][:200]
    return {
        "run": _public_run(run),
        "jobs": {"counts": counts, "items": [
            {"index": int(c["index"]), "status": c.get("status"), "attempts": int(c.get("attempts", 0)),
             "units": len(c.get("units", [])), "startedAt": c.get("startedAt"), "stoppedAt": c.get("stoppedAt"),
             "statusReason": c.get("statusReason"), "hasLog": bool(c.get("logStreamName"))}
            for c in children[:500]
        ]},
        "failedUnits": failed,
    }


def _cancel(table, run):
    if run["status"] in TERMINAL:
        raise RequestError(409, f"The run is already {run['status']}")
    table.update_item(
        Key={"pk": f"RUN#{run['runId']}", "sk": "METADATA"},
        UpdateExpression="SET cancelRequested = :t, statusReason = :r, updatedAt = :now",
        ExpressionAttributeValues={":t": True, ":r": "Cancelled by user", ":now": _now()},
    )
    if run.get("batchJobId"):
        batch.terminate_job(jobId=run["batchJobId"], reason="Cancelled by user")
    return _resp(200, {"runId": run["runId"], "status": "cancelling"})


def _child_log(table, run, raw_index):
    if not isinstance(raw_index, str) or not raw_index.isdigit():
        raise RequestError(400, "index is invalid")
    child = table.get_item(Key={"pk": f"RUN#{run['runId']}", "sk": f"CHILD#{int(raw_index):05d}"}).get("Item")
    if child is None:
        raise RequestError(404, "Job not found")
    if not child.get("logStreamName"):
        return _resp(200, {"lines": [], "note": "This job hasn't started yet"})
    try:
        events = logs.get_log_events(logGroupName=RUN_LOG_GROUP, logStreamName=child["logStreamName"],
                                     limit=1000, startFromHead=False).get("events", [])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return _resp(200, {"lines": []})
        raise
    return _resp(200, {"lines": [e["message"].rstrip("\n") for e in events]})


# --- Helpers ---------------------------------------------------------------------------

def _owned_run(table, user_id, run_id):
    _require_link(table, user_id, f"RUN#{run_id}", "Run not found")
    run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item")
    if run is None:
        raise RequestError(404, "Run not found")
    return run


def _require_link(table, user_id, sk, message):
    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": sk}).get("Item")
    if link is None:
        raise RequestError(404, message)


def _link_ids(table, pk, prefix, relation=None, limit=None):
    ids, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
                       "ScanIndexForward": False}
    while True:
        page = table.query(**kwargs)
        for row in page.get("Items", []):
            if relation and row.get("relation") != relation:
                continue
            ids.append(row["sk"].rsplit("#", 1)[-1])
        if "LastEvaluatedKey" not in page or (limit and len(ids) >= limit):
            return ids[:limit] if limit else ids
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _query_all(table, pk, prefix):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix)}
    while True:
        page = table.query(**kwargs)
        items += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return items
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


PUBLIC_RUN_FIELDS = (
    "runId", "name", "moduleId", "moduleName", "moduleVersion", "inputs", "mode", "unitsPerJob", "groupBy",
    "chunkSize", "class", "size", "vcpu", "memoryMiB", "timeoutSec", "inputCount", "unitCount", "childCount",
    "maxCost", "expectedCost", "held", "costProvisional", "unitsSucceeded", "unitsFailed", "outputCount",
    "status", "statusReason", "statusUpdatedAt", "createdAt", "startedAt", "endedAt", "cancelRequested",
)


def _public_run(item):
    out = {}
    for field in PUBLIC_RUN_FIELDS:
        if field in item:
            out[field] = _plain(item[field])
    return out


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, set)):
        return [_plain(v) for v in value]
    return value


def _money(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.match(value):
        raise RequestError(400, f"{name} is invalid")
    return value


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


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body, default=_plain),
    }
