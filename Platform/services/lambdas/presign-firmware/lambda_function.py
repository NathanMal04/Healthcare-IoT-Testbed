import base64
import json
import os
import re
import uuid
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]
PRESIGN_EXPIRES_SEC = int(os.environ.get("PRESIGN_EXPIRES_SEC", "300"))
MAX_FIRMWARE_SIZE_BYTES = int(os.environ["MAX_FIRMWARE_SIZE_BYTES"])

VERSION_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_FILENAME_LENGTH = 255

# create-device generates deviceId via str(uuid.uuid4()) — this is the
# canonical lowercase, hyphenated form that produces. Matching it exactly
# makes that API contract explicit rather than accepting any string.
DEVICE_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

CONTENT_TYPE = "application/octet-stream"


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    device_id = _validate_device_id((event.get("pathParameters") or {}).get("deviceId"))

    if device_id is None:
        return _resp(400, {"error": "deviceId is invalid or missing"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})

    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    table = dynamodb.Table(TABLE)

    if not _is_owner(table, user_id, device_id):
        return _resp(403, {"error": "Not authorized for this device"})

    version = _validate_version(body.get("version"))
    if version is None:
        return _resp(400, {"error": "version is invalid or missing"})

    pk = f"DEVICE#{device_id}"
    sk = f"FIRMWARE#{version}"

    if "retryOfAttemptId" in body and body["retryOfAttemptId"] is not None:
        retry_of_attempt_id = body["retryOfAttemptId"]
        if not isinstance(retry_of_attempt_id, str) or not retry_of_attempt_id.strip():
            return _resp(400, {"error": "retryOfAttemptId must be a non-empty string"})
        return _handle_retry(table, pk, sk, device_id, version, retry_of_attempt_id.strip())

    return _handle_first_reservation(table, pk, sk, device_id, version, user_id, body)


def _handle_first_reservation(table, pk, sk, device_id, version, user_id, body):
    original_filename = body.get("originalFilename")
    if not isinstance(original_filename, str) or not original_filename.strip():
        return _resp(400, {"error": "originalFilename is required"})
    original_filename = original_filename.strip()
    if len(original_filename) > MAX_FILENAME_LENGTH or _has_control_chars(original_filename):
        return _resp(400, {"error": "originalFilename is invalid"})

    size_bytes = body.get("sizeBytes")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        return _resp(400, {"error": "sizeBytes must be a positive integer"})
    if size_bytes > MAX_FIRMWARE_SIZE_BYTES:
        return _resp(400, {"error": f"sizeBytes exceeds maximum of {MAX_FIRMWARE_SIZE_BYTES} bytes"})

    sha256 = body.get("sha256")
    if not isinstance(sha256, str) or not SHA256_PATTERN.match(sha256):
        return _resp(400, {"error": "sha256 must be a 64-character lowercase hex string"})

    existing = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")
    if existing is not None:
        if existing["status"] == "ready":
            return _resp(409, {"error": "Firmware version is already ready"})
        if existing["status"] == "failed":
            return _resp(409, {
                "error": "Firmware version has failed and cannot be retried; choose a new version"
            })
        return _resp(409, {
            "error": f"An upload for this version already exists ({existing['status']}); "
                     f"retry explicitly to replace it"
        })

    firmware_id = str(uuid.uuid4())
    attempt_id = str(uuid.uuid4())
    s3_key = _build_s3_key(device_id, version, attempt_id)
    now = datetime.now(timezone.utc).isoformat()

    item = {
        "pk": pk,
        "sk": sk,
        "entity": "firmware",
        "firmwareId": firmware_id,
        "version": version,
        "sha256": sha256,
        "sizeBytes": size_bytes,
        "originalFilename": original_filename,
        "createdBy": user_id,
        "createdAt": now,
        "status": "pending",
        "attemptId": attempt_id,
        "s3Bucket": BUCKET,
        "s3Key": s3_key,
        "updatedAt": now,
    }

    try:
        table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(409, {"error": "An upload for this version was just started by another request"})
        raise

    return _presign_response(device_id, version, firmware_id, attempt_id, s3_key, sha256)


def _handle_retry(table, pk, sk, device_id, version, retry_of_attempt_id):
    existing = table.get_item(Key={"pk": pk, "sk": sk}).get("Item")

    if existing is None:
        return _resp(409, {"error": "No existing upload to retry"})

    if existing["status"] == "ready":
        return _resp(409, {"error": "Firmware version is already ready"})

    if existing["status"] == "failed":
        return _resp(409, {"error": "Firmware version has failed and cannot be retried; choose a new version"})

    if existing["status"] != "pending":
        return _resp(409, {"error": f"Firmware version cannot be retried from status {existing['status']}"})

    if existing["attemptId"] != retry_of_attempt_id:
        return _resp(409, {"error": "Upload attempt is no longer current"})

    firmware_id = existing["firmwareId"]
    sha256 = existing["sha256"]
    new_attempt_id = str(uuid.uuid4())
    new_s3_key = _build_s3_key(device_id, version, new_attempt_id)
    now = datetime.now(timezone.utc).isoformat()

    try:
        table.update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression=(
                "SET attemptId = :new_attempt, s3Key = :new_key, s3Bucket = :bucket, "
                "#st = :pending, updatedAt = :now"
            ),
            ConditionExpression="attemptId = :expected AND #st = :pending",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":new_attempt": new_attempt_id,
                ":new_key": new_s3_key,
                ":bucket": BUCKET,
                ":pending": "pending",
                ":expected": retry_of_attempt_id,
                ":now": now,
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(409, {"error": "Upload attempt is no longer current"})
        raise

    return _presign_response(device_id, version, firmware_id, new_attempt_id, new_s3_key, sha256)


def _presign_response(device_id, version, firmware_id, attempt_id, s3_key, sha256_hex):
    # S3-side SHA-256 enforcement: the browser must submit the exact
    # Base64-encoded digest of the immutable, DynamoDB-stored hex SHA-256 as
    # both an x-amz-checksum-sha256 form field and a matching policy
    # condition (mirroring the existing Content-Type field/condition pair
    # below, which is the same pairing mechanism S3 POST policies require
    # for any non-default field). S3 verifies the uploaded bytes against
    # this checksum at write time — the browser cannot substitute a
    # different checksum and still use this presigned POST, since any field
    # value that doesn't match its paired condition causes S3 to reject the
    # POST outright.
    checksum_b64 = _sha256_hex_to_base64(sha256_hex)

    presigned = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=s3_key,
        Fields={
            "Content-Type": CONTENT_TYPE,
            "x-amz-checksum-algorithm": "SHA256",
            "x-amz-checksum-sha256": checksum_b64,
        },
        Conditions=[
            {"Content-Type": CONTENT_TYPE},
            {"x-amz-checksum-algorithm": "SHA256"},
            {"x-amz-checksum-sha256": checksum_b64},
            ["content-length-range", 1, MAX_FIRMWARE_SIZE_BYTES],
        ],
        ExpiresIn=PRESIGN_EXPIRES_SEC,
    )

    return _resp(201, {
        "deviceId": device_id,
        "version": version,
        "firmwareId": firmware_id,
        "attemptId": attempt_id,
        "status": "pending",
        "upload": {
            "url": presigned["url"],
            "fields": presigned["fields"],
        },
    })


def _build_s3_key(device_id, version, attempt_id):
    return f"devices/{device_id}/firmware/{version}/{attempt_id}.bin"


def _validate_version(raw):
    if not isinstance(raw, str):
        return None
    version = raw.strip()
    if not VERSION_PATTERN.match(version):
        return None
    return version


def _has_control_chars(value):
    return any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value)


def _sha256_hex_to_base64(sha256_hex):
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def _validate_device_id(raw):
    if not isinstance(raw, str):
        return None
    if not DEVICE_ID_PATTERN.match(raw):
        return None
    return raw


def _is_owner(table, user_id, device_id):
    item = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
    return item is not None and item.get("role") == "owner"


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
