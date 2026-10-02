import json
import os
import re
import urllib.parse
import boto3
from boto3.dynamodb.conditions import Key

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
DOWNLOAD_EXPIRES_SEC = int(os.environ.get("DOWNLOAD_EXPIRES_SEC", "300"))

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UNSAFE_FILENAME_CHARS = re.compile(r'[^A-Za-z0-9._ -]')

RE_STATUSES = {"not_started", "in_progress", "complete"}
DEFAULT_RE_STATUS = "not_started"


def handler(event, context):
    """GET /artifacts/{artifactId} and GET /artifacts/{artifactId}/download."""
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    artifact_id = (event.get("pathParameters") or {}).get("artifactId")
    if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
        return _resp(400, {"error": "artifactId is invalid or missing"})

    table = dynamodb.Table(TABLE)
    if table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"ARTIFACT#{artifact_id}"}).get("Item") is None:
        return _resp(404, {"error": "Artifact not found"})

    item = table.get_item(Key={"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}).get("Item")
    if item is None:
        return _resp(404, {"error": "Artifact not found"})

    if event.get("resource") == "/artifacts/{artifactId}/download":
        if item.get("status") != "ready":
            return _resp(409, {"error": f"Artifact is {item.get('status')}, not ready"})
        url = s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": item["s3Bucket"],
                "Key": item["s3Key"],
                "ResponseContentDisposition": _content_disposition(item),
            },
            ExpiresIn=DOWNLOAD_EXPIRES_SEC,
        )
        return _resp(200, {"url": url, "expiresIn": DOWNLOAD_EXPIRES_SEC})

    links = table.query(
        KeyConditionExpression=Key("pk").eq(f"ARTIFACT#{artifact_id}") & Key("sk").begins_with("DEVICE#")
    ).get("Items", [])
    devices = [{"deviceId": row["sk"][len("DEVICE#"):], "name": row.get("name")} for row in links]

    return _resp(200, {"artifact": {**_public_view(item), "devices": devices}})


def _content_disposition(item):
    filename = (item.get("originalFilename") or item.get("name") or "artifact").rsplit("/", 1)[-1]
    fallback = UNSAFE_FILENAME_CHARS.sub("_", filename) or "artifact"
    encoded = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def _public_view(item):
    view = {
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
    if item.get("type") == "firmware":
        # Reverse-engineering progress, separate from the upload "status".
        # Firmware stored before the field existed reads as not started.
        value = item.get("reverseEngineeringStatus")
        view["reverseEngineeringStatus"] = value if value in RE_STATUSES else DEFAULT_RE_STATUS
    return view


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
