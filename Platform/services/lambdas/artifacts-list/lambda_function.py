import base64
import json
import os
import re
import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
ARTIFACT_TYPES = {"firmware", "pcap", "log", "binary", "other"}

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def handler(event, context):
    """GET /artifacts, GET /devices/{deviceId}/artifacts and GET /artifacts/batches.

    Query parameters: type, tag, batchId or runId (GET /artifacts only), limit, nextToken.
    With runId, only the run's outputs are listed.

    Link rows (USER#/ARTIFACT#, DEVICE#/ARTIFACT#type#, BATCH#/ARTIFACT#)
    choose which artifacts are listed, and their METADATA rows are then read
    with BatchGetItem, so status is always current. Artifact ids are
    time-ordered, so pages come back newest first. The type filter on
    GET /artifacts and the tag filter are applied per page, so a filtered
    page can hold fewer than `limit` items while nextToken is still set.
    """
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    params = event.get("queryStringParameters") or {}
    table = dynamodb.Table(TABLE)

    if event.get("resource") == "/artifacts/batches":
        return _list_batches(table, user_id)

    artifact_type = params.get("type")
    if artifact_type is not None and artifact_type not in ARTIFACT_TYPES:
        return _resp(400, {"error": f"type must be one of: {', '.join(sorted(ARTIFACT_TYPES))}"})

    tag = params.get("tag")
    limit = _parse_limit(params.get("limit"))
    if limit is None:
        return _resp(400, {"error": f"limit must be between 1 and {MAX_LIMIT}"})

    extra = {}
    relation = None
    if event.get("resource") == "/devices/{deviceId}/artifacts":
        device_id = _validate_uuid((event.get("pathParameters") or {}).get("deviceId"))
        if device_id is None:
            return _resp(400, {"error": "deviceId is invalid or missing"})
        # Same read rule as list-firmware: any USER->DEVICE relationship.
        if table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item") is None:
            return _resp(403, {"error": "Not authorized for this device"})
        pk = f"DEVICE#{device_id}"
        prefix = f"ARTIFACT#{artifact_type}#" if artifact_type else "ARTIFACT#"
        artifact_type = None  # already applied by the key condition
    elif params.get("batchId"):
        batch_id = _validate_uuid(params["batchId"])
        if batch_id is None:
            return _resp(400, {"error": "batchId is invalid"})
        if table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"BATCH#{batch_id}"}).get("Item") is None:
            return _resp(404, {"error": "Upload batch not found"})
        batch = table.get_item(Key={"pk": f"BATCH#{batch_id}", "sk": "METADATA"}).get("Item") or {}
        extra["batch"] = {
            "uploadBatchId": batch_id,
            "fileCount": int(batch.get("fileCount", 0)),
            "totalBytes": int(batch.get("totalBytes", 0)),
            "createdAt": batch.get("createdAt"),
        }
        pk = f"BATCH#{batch_id}"
        prefix = "ARTIFACT#"
    elif params.get("runId"):
        run_id = _validate_uuid(params["runId"])
        if run_id is None:
            return _resp(400, {"error": "runId is invalid"})
        if table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"RUN#{run_id}"}).get("Item") is None:
            return _resp(404, {"error": "Run not found"})
        pk = f"RUN#{run_id}"
        prefix = "ARTIFACT#"
        relation = "output"
    else:
        pk = f"USER#{user_id}"
        prefix = "ARTIFACT#"

    start_key = None
    if params.get("nextToken"):
        start_key = _decode_token(params["nextToken"], pk)
        if start_key is None:
            return _resp(400, {"error": "nextToken is invalid"})

    query = {
        "KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    if start_key:
        query["ExclusiveStartKey"] = start_key
    page = table.query(**query)

    artifact_ids = [row["sk"].rsplit("#", 1)[-1] for row in page.get("Items", [])
                    if relation is None or row.get("relation") == relation]
    items = _batch_get_metadata(artifact_ids)

    artifacts = []
    for item in sorted(items, key=lambda i: i["artifactId"], reverse=True):
        if artifact_type and item.get("type") != artifact_type:
            continue
        if tag and tag not in (item.get("tags") or set()):
            continue
        artifacts.append(_public_view(item))

    body = {"artifacts": artifacts, **extra}
    if page.get("LastEvaluatedKey"):
        body["nextToken"] = _encode_token(page["LastEvaluatedKey"])
    return _resp(200, body)


def _list_batches(table, user_id):
    """The caller's 50 most recent upload batches, for the run input picker."""
    rows = table.query(
        KeyConditionExpression=Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with("BATCH#"),
        ScanIndexForward=False, Limit=50,
    ).get("Items", [])
    keys = [{"pk": row["sk"], "sk": "METADATA"} for row in rows]
    items = []
    if keys:
        request = {TABLE: {"Keys": keys}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    batches = [{
        "uploadBatchId": i["uploadBatchId"], "fileCount": int(i.get("fileCount", 0)),
        "totalBytes": int(i.get("totalBytes", 0)), "createdAt": i.get("createdAt"),
    } for i in items]
    return _resp(200, {"batches": sorted(batches, key=lambda b: b["uploadBatchId"], reverse=True)})


def _batch_get_metadata(artifact_ids):
    if not artifact_ids:
        return []
    keys = [{"pk": f"ARTIFACT#{a}", "sk": "METADATA"} for a in dict.fromkeys(artifact_ids)]
    items = []
    request = {TABLE: {"Keys": keys}}
    while request:
        result = dynamodb.batch_get_item(RequestItems=request)
        items.extend(result.get("Responses", {}).get(TABLE, []))
        request = result.get("UnprocessedKeys") or None
    return items


def _public_view(item):
    # Leaves out pk/sk/entity, the S3 location and upload internals
    # (uploadId, createdBy). attemptId is included for the same reason
    # list-firmware includes it: the UI needs it to retry a pending or failed
    # upload, and every endpoint that accepts it re-checks ownership.
    return {
        "artifactId": item["artifactId"],
        "name": item.get("name"),
        "type": item.get("type"),
        "origin": item.get("origin"),
        "version": item.get("version"),
        "status": item.get("status"),
        "statusReason": item.get("statusReason"),
        "sizeBytes": int(item["sizeBytes"]) if item.get("sizeBytes") is not None else None,
        "sha256": item.get("sha256"),
        "originalFilename": item.get("originalFilename"),
        "tags": sorted(item.get("tags") or []),
        "deviceIds": sorted(item.get("deviceIds") or []),
        "uploadBatchId": item.get("uploadBatchId"),
        "uploadMode": item.get("uploadMode"),
        "attemptId": item.get("attemptId"),
        "createdAt": item.get("createdAt"),
        "uploadedAt": item.get("uploadedAt"),
        "statusUpdatedAt": item.get("statusUpdatedAt"),
    }


def _encode_token(last_key):
    raw = json.dumps({"pk": last_key["pk"], "sk": last_key["sk"]}).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_token(token, expected_pk):
    # The token must point into the partition being listed, otherwise it
    # could be used to page through another user's or device's rows.
    try:
        data = json.loads(base64.urlsafe_b64decode(token.encode("ascii")))
    except (ValueError, UnicodeError):
        return None
    if not isinstance(data, dict) or data.get("pk") != expected_pk or not isinstance(data.get("sk"), str):
        return None
    return {"pk": data["pk"], "sk": data["sk"]}


def _parse_limit(raw):
    if raw is None:
        return DEFAULT_LIMIT
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if 1 <= value <= MAX_LIMIT else None


def _validate_uuid(raw):
    if not isinstance(raw, str) or not UUID_PATTERN.match(raw):
        return None
    return raw


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
