"""The run manifest service: the only way a running job reaches its files.

Behind a PRIVATE API Gateway that only accepts requests through the VPC's
execute-api endpoint. Jobs have no AWS credentials; they prove which run they
belong to with the per-run token (X-Run-Token), whose SHA-256 is stored on
the run.

  POST /manifest          {runId, childIndex}                      -> work units + presigned input URLs
  POST /outputs/presign   {runId, childIndex, unitId, attempt, files:[{path, sizeBytes, sha256}]}
                                                                    -> presigned POST per output file
  POST /outputs/complete  {runId, childIndex, unitId, status, exitCode, error, outputs:[{artifactId, attemptId}]}
                                                                    -> verifies outputs, records the unit's result
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
import boto3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from boto3.dynamodb.types import TypeSerializer
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-2")


def _s3_config():
    try:
        return Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                      request_checksum_calculation="when_required", response_checksum_validation="when_required")
    except TypeError:
        return Config(signature_version="s3v4", s3={"addressing_style": "virtual"})


# Regional endpoint, so presigned URLs resolve to us-east-2 S3 addresses and
# go through the VPC's S3 gateway endpoint.
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com", config=_s3_config())
dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]
URL_EXPIRES_SEC = int(os.environ.get("URL_EXPIRES_SEC", "3600"))
MAX_FILES_PER_UNIT = int(os.environ.get("MAX_FILES_PER_UNIT", "1000"))
MAX_BYTES_PER_UNIT = int(os.environ.get("MAX_BYTES_PER_UNIT", str(20 * 1024 ** 3)))
MAX_BYTES_PER_FILE = int(os.environ.get("MAX_BYTES_PER_FILE", str(5 * 1024 ** 3)))
MAX_FILES_PER_REQUEST = 100

ACTIVE = {"queued", "running"}
PENDING_TAGGING_XML = "<Tagging><TagSet><Tag><Key>upload-state</Key><Value>pending</Value></Tag></TagSet></Tagging>"
COMMITTED_TAGSET = [{"Key": "upload-state", "Value": "committed"}]
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TYPE_BY_EXTENSION = {
    "pcap": "pcap", "pcapng": "pcap", "cap": "pcap",
    "log": "log", "txt": "log", "json": "log", "jsonl": "log", "csv": "log",
    "bin": "firmware", "img": "firmware", "hex": "firmware", "fw": "firmware",
    "elf": "binary", "so": "binary", "o": "binary", "exe": "binary", "dll": "binary", "apk": "binary",
}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def handler(event, context):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    try:
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict):
            raise ValueError
    except ValueError:
        return _resp(400, {"error": "Invalid JSON"})

    table = dynamodb.Table(TABLE)
    try:
        run, child = _authorize(table, headers.get("x-run-token"), body)
        resource = event.get("resource")
        if resource == "/manifest":
            return _resp(200, _manifest(table, run, child))
        if resource == "/outputs/presign":
            return _resp(200, _presign_outputs(table, run, child, body))
        if resource == "/outputs/complete":
            return _resp(200, _complete_unit(table, run, child, body))
    except RequestError as e:
        return _resp(e.status, {"error": e.message})
    return _resp(404, {"error": "Unknown route"})


def _authorize(table, token, body):
    run_id = body.get("runId")
    if not isinstance(run_id, str) or not UUID_PATTERN.match(run_id) or not isinstance(token, str):
        raise RequestError(403, "Forbidden")
    run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item")
    if run is None or not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), run.get("tokenHash", "")):
        raise RequestError(403, "Forbidden")
    if run.get("status") not in ACTIVE or run.get("cancelRequested") or run.get("stopReason"):
        raise RequestError(409, f"The run is {run.get('status')}")
    index = body.get("childIndex")
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < int(run["childCount"]):
        raise RequestError(400, "childIndex is invalid")
    child = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": f"CHILD#{index:05d}"}).get("Item")
    if child is None:
        raise RequestError(404, "Job not found")
    return run, child


def _unit(child, unit_id):
    for unit in child.get("units", []):
        if unit["unitId"] == unit_id:
            return unit
    raise RequestError(400, "unitId does not belong to this job")


# --- POST /manifest ---------------------------------------------------------------

def _manifest(table, run, child):
    run_id = run["runId"]
    units = child.get("units", [])
    artifact_ids = sorted({a for u in units for a in u["artifactIds"]})
    artifacts = {a["artifactId"]: a for a in _batch_get([{"pk": f"ARTIFACT#{a}", "sk": "METADATA"} for a in artifact_ids])}
    done = {r["sk"][len("RESULT#"):] for r in _batch_get(
        [{"pk": f"RUN#{run_id}", "sk": f"RESULT#{u['unitId']}"} for u in units])}

    result = []
    for unit in units:
        is_done = unit["unitId"] in done
        inputs = []
        for aid in unit["artifactIds"]:
            art = artifacts.get(aid)
            if art is None:
                continue
            entry = {
                "artifactId": aid, "name": art.get("name"), "originalFilename": art.get("originalFilename"),
                "type": art.get("type"), "sha256": art.get("sha256"), "sizeBytes": int(art.get("sizeBytes", 0)),
                "tags": sorted(art.get("tags") or []),
            }
            if not is_done:
                entry["url"] = s3.generate_presigned_url(
                    "get_object", Params={"Bucket": art["s3Bucket"], "Key": art["s3Key"]}, ExpiresIn=URL_EXPIRES_SEC)
            inputs.append(entry)
        result.append({"unitId": unit["unitId"], "key": unit["key"], "done": is_done, "inputs": inputs})

    # The first manifest request means the job is running.
    _mark_running(table, run_id)
    return {
        "runId": run_id, "childIndex": int(child["index"]), "units": result,
        "limits": {"maxFilesPerUnit": MAX_FILES_PER_UNIT, "maxBytesPerUnit": MAX_BYTES_PER_UNIT,
                   "maxBytesPerFile": MAX_BYTES_PER_FILE},
    }


def _mark_running(table, run_id):
    try:
        table.update_item(
            Key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
            UpdateExpression="SET #st = :r, startedAt = if_not_exists(startedAt, :now), statusUpdatedAt = :now",
            ConditionExpression="#st = :q",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":r": "running", ":q": "queued", ":now": _now()},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


# --- POST /outputs/presign ------------------------------------------------------------

def _presign_outputs(table, run, child, body):
    unit = _unit(child, body.get("unitId"))
    run_id = run["runId"]
    if table.get_item(Key={"pk": f"RUN#{run_id}", "sk": f"RESULT#{unit['unitId']}"}).get("Item"):
        raise RequestError(409, "This work unit is already finished")

    files = body.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_FILES_PER_REQUEST:
        raise RequestError(400, f"files must be a list of 1 to {MAX_FILES_PER_REQUEST} entries")
    specs = [_validate_output(f) for f in files]

    # Per-attempt totals, so a retried job starts from zero.
    attempt = str(body.get("attempt") or "1")[:8]
    total = sum(s["sizeBytes"] for s in specs)
    try:
        table.update_item(
            Key={"pk": f"RUN#{run_id}", "sk": f"OUTCOUNT#{unit['unitId']}#{attempt}"},
            UpdateExpression="ADD files :n, bytes :b SET entity = :e",
            ConditionExpression="attribute_not_exists(files) OR (files <= :max_files AND bytes <= :max_bytes)",
            ExpressionAttributeValues={
                ":n": len(specs), ":b": total, ":e": "run-output-count",
                ":max_files": MAX_FILES_PER_UNIT - len(specs), ":max_bytes": MAX_BYTES_PER_UNIT - total,
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise RequestError(413, "This work unit's outputs are over the file-count or size limit")
        raise
    if len(specs) > MAX_FILES_PER_UNIT or total > MAX_BYTES_PER_UNIT:
        raise RequestError(413, "This work unit's outputs are over the file-count or size limit")

    inputs = unit["artifactIds"]
    owner = run["createdBy"]
    presigned = []
    for spec in specs:
        artifact_id, attempt_id = _uuid7(), str(uuid.uuid4())
        s3_key = f"artifacts/{artifact_id}/{attempt_id}"
        now = _now()
        name = spec["path"].rsplit("/", 1)[-1][:255]
        item = {
            "pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA", "entity": "artifact", "artifactId": artifact_id,
            "name": name, "type": TYPE_BY_EXTENSION.get(name.rsplit(".", 1)[-1].lower() if "." in name else "", "other"),
            "origin": "run", "sha256": spec["sha256"], "sizeBytes": spec["sizeBytes"],
            "originalFilename": spec["path"], "s3Bucket": BUCKET, "s3Key": s3_key, "attemptId": attempt_id,
            "uploadMode": "single", "status": "pending", "statusUpdatedAt": now,
            "derivedFromRun": run_id, "derivedFromArtifacts": set(inputs), "runUnitId": unit["unitId"],
            "createdBy": owner, "createdAt": now, "updatedAt": now,
        }
        client.transact_write_items(TransactItems=[
            _put(item),
            _put({"pk": f"USER#{owner}", "sk": f"ARTIFACT#{artifact_id}", "entity": "user-artifact",
                  "role": "owner", "name": name, "type": item["type"], "createdAt": now}),
            _put({"pk": f"ARTIFACT#{artifact_id}", "sk": f"USER#{owner}", "entity": "artifact-user", "role": "owner"}),
        ])
        checksum = base64.b64encode(bytes.fromhex(spec["sha256"])).decode()
        post = s3.generate_presigned_post(
            Bucket=BUCKET, Key=s3_key,
            Fields={"Content-Type": "application/octet-stream", "x-amz-checksum-algorithm": "SHA256",
                    "x-amz-checksum-sha256": checksum, "tagging": PENDING_TAGGING_XML},
            Conditions=[{"Content-Type": "application/octet-stream"}, {"x-amz-checksum-algorithm": "SHA256"},
                        {"x-amz-checksum-sha256": checksum}, {"tagging": PENDING_TAGGING_XML},
                        ["content-length-range", spec["sizeBytes"], spec["sizeBytes"]]],
            ExpiresIn=URL_EXPIRES_SEC,
        )
        presigned.append({"path": spec["path"], "artifactId": artifact_id, "attemptId": attempt_id,
                          "upload": {"url": post["url"], "fields": post["fields"]}})
    return {"files": presigned}


def _validate_output(raw):
    if not isinstance(raw, dict):
        raise RequestError(400, "Each file must be an object")
    path = raw.get("path")
    if (not isinstance(path, str) or not 0 < len(path) <= 512 or path.startswith("/")
            or ".." in path.split("/") or any(ord(c) < 0x20 for c in path)):
        raise RequestError(400, f"Invalid output path: {path!r}")
    size = raw.get("sizeBytes")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_BYTES_PER_FILE:
        raise RequestError(400, f"{path}: sizeBytes must be between 1 and {MAX_BYTES_PER_FILE}")
    sha = raw.get("sha256")
    if not isinstance(sha, str) or not SHA256_PATTERN.match(sha):
        raise RequestError(400, f"{path}: sha256 is invalid")
    return {"path": path, "sizeBytes": size, "sha256": sha}


# --- POST /outputs/complete -------------------------------------------------------------

def _complete_unit(table, run, child, body):
    unit = _unit(child, body.get("unitId"))
    run_id = run["runId"]
    result_key = {"pk": f"RUN#{run_id}", "sk": f"RESULT#{unit['unitId']}"}
    if table.get_item(Key=result_key).get("Item"):
        return {"status": "already-recorded"}

    status = body.get("status")
    if status not in ("succeeded", "failed"):
        raise RequestError(400, "status must be succeeded or failed")
    error = str(body.get("error") or "")[-2000:]
    outputs = body.get("outputs") or []
    if not isinstance(outputs, list) or len(outputs) > MAX_FILES_PER_UNIT:
        raise RequestError(400, "outputs is invalid")

    output_ids = []
    if status == "succeeded" and outputs:
        output_ids, problems = _verify_outputs(table, run_id, unit["unitId"], outputs)
        if problems:
            status, error = "failed", f"{len(problems)} output(s) failed verification: {problems[0]}"
            output_ids = []

    result = {
        **result_key, "entity": "run-result", "key": unit["key"], "status": status,
        "inputArtifactIds": unit["artifactIds"], "outputArtifactIds": output_ids,
        "exitCode": int(body.get("exitCode") or 0), "childIndex": int(child["index"]), "recordedAt": _now(),
    }
    if error:
        result["error"] = error
    try:
        table.put_item(Item=result, ConditionExpression="attribute_not_exists(pk)")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"status": "already-recorded"}
        raise

    with table.batch_writer() as writer:
        for aid in output_ids:
            writer.put_item(Item={"pk": f"RUN#{run_id}", "sk": f"ARTIFACT#{aid}", "entity": "run-artifact",
                                  "relation": "output", "unitKey": unit["key"]})
            writer.put_item(Item={"pk": f"ARTIFACT#{aid}", "sk": f"RUN#{run_id}", "entity": "artifact-run",
                                  "relation": "output", "name": run.get("name")})
    counter = "unitsSucceeded" if status == "succeeded" else "unitsFailed"
    table.update_item(
        Key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
        UpdateExpression=f"ADD {counter} :one, outputCount :n",
        ExpressionAttributeValues={":one": 1, ":n": len(output_ids)},
    )
    return {"status": status, "outputs": len(output_ids)}


def _verify_outputs(table, run_id, unit_id, outputs):
    """Same checks as artifacts-complete for single uploads. Returns
    (ready artifact ids, problems). DynamoDB calls stay on this thread
    (boto3 resources aren't thread-safe); only the S3 checks run in parallel."""
    wanted = [o for o in outputs if isinstance(o, dict) and isinstance(o.get("artifactId"), str)
              and UUID_PATTERN.match(o["artifactId"])]
    if len(wanted) != len(outputs):
        return [], ["malformed output entry"]
    items = {i["artifactId"]: i for i in _batch_get([{"pk": f"ARTIFACT#{o['artifactId']}", "sk": "METADATA"} for o in wanted])}

    problems, to_check = [], []
    for o in wanted:
        item = items.get(o["artifactId"])
        if (item is None or item.get("derivedFromRun") != run_id or item.get("runUnitId") != unit_id
                or item.get("attemptId") != o.get("attemptId")):
            problems.append(f"{o['artifactId']} does not belong to this work unit")
        elif item["status"] != "ready":
            to_check.append(item)
    if problems:
        return [], problems

    def check(item):
        try:
            head = s3.head_object(Bucket=item["s3Bucket"], Key=item["s3Key"], ChecksumMode="ENABLED")
        except ClientError:
            return f"{item['originalFilename']} was not uploaded"
        expected = base64.b64encode(bytes.fromhex(item["sha256"])).decode()
        if head["ContentLength"] != int(item["sizeBytes"]) or head.get("ChecksumSHA256") != expected:
            return f"{item['originalFilename']} does not match its declared size and SHA-256"
        s3.put_object_tagging(Bucket=item["s3Bucket"], Key=item["s3Key"], Tagging={"TagSet": COMMITTED_TAGSET})
        return None

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(check, to_check))
    problems = [r for r in results if r]
    if problems:
        return [], problems

    now = _now()
    for item in to_check:
        try:
            table.update_item(
                Key={"pk": item["pk"], "sk": "METADATA"},
                UpdateExpression="SET #st = :ready, uploadedAt = :now, statusUpdatedAt = :now, updatedAt = :now",
                ConditionExpression="#st = :pending",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={":ready": "ready", ":pending": "pending", ":now": now},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    return [o["artifactId"] for o in wanted], []


# --- Helpers ---------------------------------------------------------------------------

def _batch_get(keys):
    items = []
    for start in range(0, len(keys), 100):
        request = {TABLE: {"Keys": keys[start:start + 100]}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    return items


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
    return {"statusCode": status, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body)}
