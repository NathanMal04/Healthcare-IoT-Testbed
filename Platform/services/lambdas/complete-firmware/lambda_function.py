import base64
import json
import os
import re
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

VERSION_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$")

# create-device generates deviceId via str(uuid.uuid4()) — this is the
# canonical lowercase, hyphenated form that produces. Matching it exactly
# makes that API contract explicit rather than accepting any string.
DEVICE_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    path_params = event.get("pathParameters") or {}
    device_id = _validate_device_id(path_params.get("deviceId"))

    if device_id is None:
        return _resp(400, {"error": "deviceId is invalid or missing"})

    version = _validate_version(path_params.get("version"))
    if version is None:
        return _resp(400, {"error": "version is invalid or missing"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})

    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    attempt_id = body.get("attemptId")
    if not isinstance(attempt_id, str) or not attempt_id:
        return _resp(400, {"error": "attemptId is required"})

    table = dynamodb.Table(TABLE)

    if not _is_owner(table, user_id, device_id):
        return _resp(403, {"error": "Not authorized for this device"})

    pk = f"DEVICE#{device_id}"
    sk = f"FIRMWARE#{version}"

    item = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")
    if item is None:
        return _resp(404, {"error": "Firmware not found"})

    status = item["status"]

    if status == "ready":
        if item["attemptId"] == attempt_id:
            return _resp(200, _success_body(device_id, version, item))
        return _resp(409, {"error": "Upload attempt is no longer current"})

    if status == "failed":
        return _resp(409, {"error": "This upload attempt has failed; retry explicitly to try again"})

    # status == "pending" (the only remaining value any item written by
    # presign-firmware can have)
    if item["attemptId"] != attempt_id:
        return _resp(409, {"error": "Upload attempt is no longer current"})

    # s3Bucket/s3Key/sizeBytes/sha256 all come from the stored record, never
    # from the request — the browser only identifies which attempt it is
    # completing.
    try:
        head = s3.head_object(
            Bucket=item["s3Bucket"], Key=item["s3Key"], ChecksumMode="ENABLED"
        )
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("404", "NoSuchKey"):
            # The backend cannot distinguish "still uploading", "browser
            # never sent it", and "upload silently failed" from a missing
            # object — none of those are a definitive verification failure,
            # so this is a retryable conflict, not a transition to failed.
            return _resp(409, {"error": "Uploaded object not found yet; retry once the upload has completed"})
        raise

    now = datetime.now(timezone.utc).isoformat()

    # Verification requires BOTH a matching size AND a matching S3-attested
    # SHA-256 checksum (never ETag — for single-part uploads ETag is
    # generally an MD5, not a SHA-256, and is never treated as a substitute
    # here). ChecksumMode="ENABLED" asks S3 to return the additional
    # checksum it stored for the object at upload time, if any; comparing
    # requires converting our immutable hex digest to the same Base64 form
    # S3 reports (never hex-vs-Base64 directly).
    #
    # A HeadObject success with ChecksumSHA256 absent is treated as a
    # definitive verification failure, not as "still pending". This differs
    # from a missing object: a missing object may simply not have finished
    # uploading yet and could legitimately succeed on a later retry of this
    # same call, but a completed object's checksum attribute is fixed at
    # upload time — if it isn't present now, it will never appear on a
    # later HeadObject call for this same object, so leaving the record
    # "pending" would misleadingly imply progress is still possible.
    actual_size = head["ContentLength"]
    actual_checksum = head.get("ChecksumSHA256")
    expected_checksum = _sha256_hex_to_base64(item["sha256"])

    if actual_size != item["sizeBytes"] or actual_checksum != expected_checksum:
        try:
            table.update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="SET #st = :failed, updatedAt = :now",
                ConditionExpression="attemptId = :expected AND #st = :pending",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":failed": "failed",
                    ":pending": "pending",
                    ":expected": attempt_id,
                    ":now": now,
                },
            )
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            # Lost the race: another request already changed this item's
            # state (e.g. an explicit retry moved it to a new attempt).
            # Reason from the current authoritative record rather than
            # assuming our verification result still applies to it.
            refreshed = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")
            if refreshed and refreshed["attemptId"] != attempt_id:
                return _resp(409, {"error": "Upload attempt is no longer current"})
        return _resp(422, {"error": "Uploaded object does not match the registered firmware"})

    try:
        table.update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression="SET #st = :ready, uploadedAt = :now, updatedAt = :now",
            ConditionExpression="attemptId = :expected AND #st = :pending",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":ready": "ready",
                ":pending": "pending",
                ":expected": attempt_id,
                ":now": now,
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        refreshed = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")
        if refreshed and refreshed["status"] == "ready" and refreshed["attemptId"] == attempt_id:
            return _resp(200, _success_body(device_id, version, refreshed))
        return _resp(409, {"error": "Upload attempt is no longer current"})

    updated = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")
    return _resp(200, _success_body(device_id, version, updated))


def _success_body(device_id, version, item):
    return {
        "deviceId": device_id,
        "version": version,
        "firmwareId": item["firmwareId"],
        "status": item["status"],
        "uploadedAt": item.get("uploadedAt"),
    }


def _validate_version(raw):
    if not isinstance(raw, str):
        return None
    version = raw.strip()
    if not VERSION_PATTERN.match(version):
        return None
    return version


def _is_owner(table, user_id, device_id):
    item = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
    return item is not None and item.get("role") == "owner"


def _sha256_hex_to_base64(sha256_hex):
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def _validate_device_id(raw):
    if not isinstance(raw, str):
        return None
    if not DEVICE_ID_PATTERN.match(raw):
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
