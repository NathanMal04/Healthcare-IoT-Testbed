import json
import os
import re
import urllib.parse
import boto3
import image_fields
import testbed_authz
from boto3.dynamodb.conditions import Key

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
DOWNLOAD_EXPIRES_SEC = int(os.environ.get("DOWNLOAD_EXPIRES_SEC", "300"))
# POST /artifacts/view-urls: how long an inline image URL works, and how many
# images one request may ask for (one gallery or notebook page).
VIEW_URL_EXPIRES_SEC = int(os.environ.get("VIEW_URL_EXPIRES_SEC", "300"))
MAX_VIEW_IDS = 100

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UNSAFE_FILENAME_CHARS = re.compile(r'[^A-Za-z0-9._ -]')

RE_STATUSES = {"not_started", "in_progress", "complete"}
DEFAULT_RE_STATUS = "not_started"


def handler(event, context):
    """GET /artifacts/{artifactId}, GET /artifacts/{artifactId}/download and
    POST /artifacts/view-urls."""
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    if event.get("resource") == "/artifacts/view-urls":
        return _handle_view_urls(user_id, event)

    artifact_id = (event.get("pathParameters") or {}).get("artifactId")
    if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
        return _resp(400, {"error": "artifactId is invalid or missing"})

    table = dynamodb.Table(TABLE)
    # Any USER#/ARTIFACT# link may read and download, whatever its role, and
    # any member of a workspace artifact's workspace, viewers included; 404
    # otherwise so the endpoint doesn't reveal which artifact ids exist.
    try:
        item = testbed_authz.require_resource(
            table, user_id, "ARTIFACT", artifact_id, legacy_roles=testbed_authz.ANY_ROLE,
            workspace_roles=testbed_authz.MEMBERSHIP_ROLES,
        )
    except testbed_authz.AuthorizationError:
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


def _handle_view_urls(user_id, event):
    """POST /artifacts/view-urls {"artifactIds": [...]}: short-lived URLs that
    display ready images inline, e.g. in a device gallery or (later) in a
    notebook entry that references the image by its artifactId.

    Each id is checked on its own, with the same read rule as
    GET /artifacts/{artifactId}: any USER#/ARTIFACT# link for a personal
    artifact, membership of its workspace for a workspace artifact. An id
    that is missing, not visible to the caller, not an image or not ready
    gets the same 404 result, so the endpoint can't be used to learn which
    ids exist or what they are. The request as a whole succeeds (200) with
    one result per distinct id, in request order.
    """
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})
    ids = body.get("artifactIds") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not ids:
        return _resp(400, {"error": "artifactIds must be a non-empty list"})
    if len(ids) > MAX_VIEW_IDS:
        return _resp(400, {"error": f"At most {MAX_VIEW_IDS} artifactIds per request"})

    table = dynamodb.Table(TABLE)
    results, seen = [], set()
    for artifact_id in ids:
        if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
            results.append({"artifactId": artifact_id if isinstance(artifact_id, str) else None,
                            "ok": False, "status": 400, "error": "artifactId is invalid"})
            continue
        if artifact_id in seen:
            continue
        seen.add(artifact_id)
        item = _viewable_image(table, user_id, artifact_id)
        if item is None:
            results.append({"artifactId": artifact_id, "ok": False, "status": 404, "error": "Image not found"})
            continue
        url = s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": item["s3Bucket"],
                "Key": item["s3Key"],
                "ResponseContentType": item["mimeType"],
                "ResponseContentDisposition": _content_disposition(item, "inline"),
                "ResponseCacheControl": f"private, max-age={VIEW_URL_EXPIRES_SEC}",
            },
            ExpiresIn=VIEW_URL_EXPIRES_SEC,
        )
        results.append({"artifactId": artifact_id, "ok": True, "url": url, "mimeType": item["mimeType"],
                         "expiresIn": VIEW_URL_EXPIRES_SEC})
    return _resp(200, {"results": results})


def _viewable_image(table, user_id, artifact_id):
    """The artifact's METADATA if the caller may read it and it is a ready
    image with a supported MIME type; None otherwise, whatever the reason."""
    try:
        item = testbed_authz.require_resource(
            table, user_id, "ARTIFACT", artifact_id, legacy_roles=testbed_authz.ANY_ROLE,
            workspace_roles=testbed_authz.MEMBERSHIP_ROLES,
        )
    except testbed_authz.AuthorizationError:
        return None
    if (item.get("type") != image_fields.IMAGE_TYPE or item.get("status") != "ready"
            or item.get("mimeType") not in image_fields.IMAGE_MIME_TYPES
            or not item.get("s3Bucket") or not item.get("s3Key")):
        return None
    return item


def _content_disposition(item, disposition="attachment"):
    filename = (item.get("originalFilename") or item.get("name") or "artifact").rsplit("/", 1)[-1]
    fallback = UNSAFE_FILENAME_CHARS.sub("_", filename) or "artifact"
    encoded = urllib.parse.quote(filename, safe="")
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


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
    if item.get("workspaceId"):
        # Only on workspace artifacts, so personal responses are unchanged.
        view["workspaceId"] = item["workspaceId"]
    if item.get("type") == "firmware":
        # Reverse-engineering progress, separate from the upload "status".
        # Firmware stored before the field existed reads as not started.
        value = item.get("reverseEngineeringStatus")
        view["reverseEngineeringStatus"] = value if value in RE_STATUSES else DEFAULT_RE_STATUS
    if item.get("type") == image_fields.IMAGE_TYPE:
        # title, description, mimeType, capturedAt, updatedAt; only on images,
        # so responses for other types are unchanged.
        view.update(image_fields.public_fields(item))
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
