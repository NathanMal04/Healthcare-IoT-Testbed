import base64
import json
import os
import re
import secrets
import time
import uuid
import boto3
from datetime import datetime, timezone
from boto3.dynamodb.types import TypeSerializer
from botocore.config import Config
from botocore.exceptions import ClientError


def _s3_config():
    # Presigned URLs must not carry SDK-added checksums: the browser supplies
    # the only checksum (the SHA-256 declared at presign time), and anything
    # botocore added on its own would be signed into the URL for an empty
    # body. botocore releases before 1.36 don't know these options and never
    # add checksums anyway.
    try:
        return Config(
            signature_version="s3v4",
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    except TypeError:
        return Config(signature_version="s3v4")


s3 = boto3.client("s3", config=_s3_config())
dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]
PRESIGN_EXPIRES_SEC = int(os.environ.get("PRESIGN_EXPIRES_SEC", "3600"))
PART_URL_EXPIRES_SEC = int(os.environ.get("PART_URL_EXPIRES_SEC", "900"))
MAX_ARTIFACT_SIZE_BYTES = int(os.environ.get("MAX_ARTIFACT_SIZE_BYTES", str(5 * 1024 ** 3)))
SINGLE_UPLOAD_MAX_BYTES = int(os.environ.get("SINGLE_UPLOAD_MAX_BYTES", str(25 * 1024 ** 2)))

MAX_FILES_PER_REQUEST = 100
MAX_PARTS_PER_REQUEST = 100
MAX_DEVICES = 10
MAX_TAGS = 20
MAX_FILENAME_LENGTH = 512
MAX_NAME_LENGTH = 255
MAX_CLIENT_REF_LENGTH = 64

# Multipart parts are at least 16 MiB and there are never more than 1000 of
# them, so a 5 GiB file uses ~320 parts and the part list stays small.
MIN_PART_SIZE = 16 * 1024 ** 2
MAX_PARTS = 1000

ARTIFACT_TYPES = {"firmware", "pcap", "log", "binary", "other"}
CONTENT_TYPE = "application/octet-stream"

# Objects stay tagged "pending" until the upload is verified. The bucket's
# lifecycle rule expires pending objects, which cleans up superseded retry
# attempts and uploads that were never completed.
PENDING_TAGGING = "upload-state=pending"
PENDING_TAGGING_XML = (
    "<Tagging><TagSet><Tag><Key>upload-state</Key><Value>pending</Value></Tag></TagSet></Tagging>"
)

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TAG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/=+@-]{0,63}$")


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})

    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    table = dynamodb.Table(TABLE)
    resource = event.get("resource")

    try:
        if resource == "/artifacts/presign":
            return _handle_presign(table, user_id, body)

        artifact_id = _validate_uuid((event.get("pathParameters") or {}).get("artifactId"))
        if artifact_id is None:
            return _resp(400, {"error": "artifactId is invalid or missing"})

        if resource == "/artifacts/{artifactId}/parts":
            return _handle_parts(table, user_id, artifact_id, body)
        if resource == "/artifacts/{artifactId}/retry":
            return _handle_retry(table, user_id, artifact_id, body)
    except RequestError as e:
        return _resp(e.status, {"error": e.message})

    return _resp(404, {"error": "Unknown route"})


# --- POST /artifacts/presign -------------------------------------------------

def _handle_presign(table, user_id, body):
    files = body.get("files")
    if not isinstance(files, list) or not files:
        return _resp(400, {"error": "files must be a non-empty list"})
    if len(files) > MAX_FILES_PER_REQUEST:
        return _resp(400, {"error": f"At most {MAX_FILES_PER_REQUEST} files per request"})

    tags = _validate_tags(body.get("tags"))
    devices = _resolve_devices(table, user_id, body.get("deviceIds"))
    batch_id = _resolve_batch(table, user_id, body.get("uploadBatchId"))

    results = []
    accepted_count = 0
    accepted_bytes = 0

    for index, raw in enumerate(files):
        client_ref = _client_ref(raw, index)
        try:
            spec = _validate_file(raw)
            result = _create_artifact(user_id, batch_id, tags, devices, spec)
        except RequestError as e:
            results.append({"clientRef": client_ref, "ok": False, "status": e.status, "error": e.message})
            continue
        accepted_count += 1
        accepted_bytes += spec["sizeBytes"]
        results.append({"clientRef": client_ref, "ok": True, **result})

    if accepted_count:
        table.update_item(
            Key={"pk": f"BATCH#{batch_id}", "sk": "METADATA"},
            UpdateExpression="ADD fileCount :n, totalBytes :b SET updatedAt = :now",
            ExpressionAttributeValues={":n": accepted_count, ":b": accepted_bytes, ":now": _now()},
        )

    return _resp(200, {"uploadBatchId": batch_id, "results": results})


def _create_artifact(user_id, batch_id, tags, devices, spec):
    artifact_id = _uuid7()
    attempt_id = str(uuid.uuid4())
    s3_key = _build_s3_key(artifact_id, attempt_id)
    now = _now()
    size = spec["sizeBytes"]

    item = {
        "pk": f"ARTIFACT#{artifact_id}",
        "sk": "METADATA",
        "entity": "artifact",
        "artifactId": artifact_id,
        "name": spec["name"],
        "type": spec["type"],
        "origin": "upload",
        "sha256": spec["sha256"],
        "sizeBytes": size,
        "originalFilename": spec["originalFilename"],
        "s3Bucket": BUCKET,
        "s3Key": s3_key,
        "attemptId": attempt_id,
        "uploadBatchId": batch_id,
        "status": "pending",
        "statusUpdatedAt": now,
        "createdBy": user_id,
        "createdAt": now,
        "updatedAt": now,
    }
    if spec.get("version"):
        item["version"] = spec["version"]
    if tags:
        item["tags"] = set(tags)
    if devices:
        item["deviceIds"] = set(devices)

    upload_id = None
    if size <= SINGLE_UPLOAD_MAX_BYTES:
        item["uploadMode"] = "single"
    else:
        part_size = _part_size(size)
        upload_id = _create_multipart_upload(s3_key)
        item["uploadMode"] = "multipart"
        item["uploadId"] = upload_id
        item["partSize"] = part_size
        item["partCount"] = -(-size // part_size)

    transact_items = [
        _put(item),
        _put({
            "pk": f"USER#{user_id}", "sk": f"ARTIFACT#{artifact_id}", "entity": "user-artifact",
            "role": "owner", "name": spec["name"], "type": spec["type"], "createdAt": now,
        }),
        _put({
            "pk": f"ARTIFACT#{artifact_id}", "sk": f"USER#{user_id}", "entity": "artifact-user",
            "role": "owner",
        }),
        _put({
            "pk": f"BATCH#{batch_id}", "sk": f"ARTIFACT#{artifact_id}", "entity": "batch-artifact",
            "name": spec["name"], "type": spec["type"],
        }),
    ]
    for device_id, device_name in devices.items():
        transact_items.append(_put({
            "pk": f"DEVICE#{device_id}", "sk": f"ARTIFACT#{spec['type']}#{artifact_id}",
            "entity": "device-artifact", "name": spec["name"], "type": spec["type"],
        }))
        transact_items.append(_put({
            "pk": f"ARTIFACT#{artifact_id}", "sk": f"DEVICE#{device_id}",
            "entity": "artifact-device", "name": device_name,
        }))

    # Firmware versions are unique per device. The guard rows are the last
    # items in the transaction so a cancellation reason can be mapped back to
    # the device whose version is already taken.
    guard_devices = []
    if spec["type"] == "firmware" and spec.get("version"):
        for device_id in devices:
            guard_devices.append(device_id)
            transact_items.append(_put({
                "pk": f"DEVICE#{device_id}", "sk": f"FWVER#{spec['version']}",
                "entity": "device-firmware-version", "artifactId": artifact_id,
                "version": spec["version"], "createdAt": now,
            }))

    try:
        client.transact_write_items(TransactItems=transact_items)
    except ClientError as e:
        if upload_id:
            _abort_multipart_upload(s3_key, upload_id)
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            reasons = e.response.get("CancellationReasons", [])
            guard_start = len(transact_items) - len(guard_devices)
            for offset, reason in enumerate(reasons[guard_start:]):
                if reason.get("Code") == "ConditionalCheckFailed":
                    raise RequestError(
                        409,
                        f"Firmware version {spec['version']} already exists on device {guard_devices[offset]}",
                    )
            print(json.dumps({
                "event": "artifact_presign_transaction_canceled",
                "artifactId": artifact_id,
                "cancellationReasons": [
                    {"code": r.get("Code"), "message": r.get("Message")} for r in reasons
                ],
            }))
            raise RequestError(500, "Failed to register the upload")
        raise

    return {"artifactId": artifact_id, **_upload_instructions(item)}


# --- POST /artifacts/{artifactId}/parts --------------------------------------

def _handle_parts(table, user_id, artifact_id, body):
    item = _get_owned_artifact(table, user_id, artifact_id)

    attempt_id = body.get("attemptId")
    if not isinstance(attempt_id, str) or not attempt_id:
        return _resp(400, {"error": "attemptId is required"})
    if item.get("uploadMode") != "multipart":
        return _resp(409, {"error": "This upload is not a multipart upload"})
    if item["status"] != "pending" or item["attemptId"] != attempt_id:
        return _resp(409, {"error": "Upload attempt is no longer current"})

    parts = body.get("parts")
    if not isinstance(parts, list) or not parts:
        return _resp(400, {"error": "parts must be a non-empty list"})
    if len(parts) > MAX_PARTS_PER_REQUEST:
        return _resp(400, {"error": f"At most {MAX_PARTS_PER_REQUEST} parts per request"})

    part_count = int(item["partCount"])
    signed = []
    for part in parts:
        if not isinstance(part, dict):
            return _resp(400, {"error": "Each part must be an object"})
        part_number = part.get("partNumber")
        if not _is_int(part_number) or not 1 <= part_number <= part_count:
            return _resp(400, {"error": f"partNumber must be between 1 and {part_count}"})
        sha256 = part.get("sha256")
        if not isinstance(sha256, str) or not SHA256_PATTERN.match(sha256):
            return _resp(400, {"error": "Each part needs a 64-character lowercase hex sha256"})

        checksum_b64 = _sha256_hex_to_base64(sha256)
        # ChecksumSHA256 becomes a signed x-amz-checksum-sha256 header: the
        # browser has to send exactly this value, and S3 rejects the part if
        # the bytes don't match it.
        url = s3.generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": item["s3Bucket"],
                "Key": item["s3Key"],
                "UploadId": item["uploadId"],
                "PartNumber": part_number,
                "ChecksumSHA256": checksum_b64,
            },
            ExpiresIn=PART_URL_EXPIRES_SEC,
        )
        signed.append({
            "partNumber": part_number,
            "url": url,
            "headers": {"x-amz-checksum-sha256": checksum_b64},
        })

    return _resp(200, {"artifactId": artifact_id, "attemptId": attempt_id, "parts": signed})


# --- POST /artifacts/{artifactId}/retry --------------------------------------

def _handle_retry(table, user_id, artifact_id, body):
    item = _get_owned_artifact(table, user_id, artifact_id)

    attempt_id = body.get("attemptId")
    if not isinstance(attempt_id, str) or not attempt_id:
        return _resp(400, {"error": "attemptId is required"})
    if item["status"] not in ("pending", "failed"):
        return _resp(409, {"error": f"Upload cannot be retried from status {item['status']}"})
    if item["attemptId"] != attempt_id:
        return _resp(409, {"error": "Upload attempt is no longer current"})

    new_attempt_id = str(uuid.uuid4())
    new_key = _build_s3_key(artifact_id, new_attempt_id)
    now = _now()

    assignments = [
        "attemptId = :new_attempt",
        "s3Key = :new_key",
        "#st = :pending",
        "statusUpdatedAt = :now",
        "updatedAt = :now",
    ]
    values = {
        ":new_attempt": new_attempt_id,
        ":new_key": new_key,
        ":pending": "pending",
        ":failed": "failed",
        ":expected": attempt_id,
        ":now": now,
    }

    new_upload_id = None
    if item.get("uploadMode") == "multipart":
        new_upload_id = _create_multipart_upload(new_key)
        assignments.append("uploadId = :upload_id")
        values[":upload_id"] = new_upload_id

    try:
        updated = table.update_item(
            Key={"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"},
            UpdateExpression=f"SET {', '.join(assignments)} REMOVE statusReason",
            ConditionExpression="attemptId = :expected AND #st IN (:pending, :failed)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if new_upload_id:
            _abort_multipart_upload(new_key, new_upload_id)
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(409, {"error": "Upload attempt is no longer current"})
        raise

    if item.get("uploadMode") == "multipart" and item.get("uploadId"):
        _abort_multipart_upload(item["s3Key"], item["uploadId"])

    return _resp(200, {"artifactId": artifact_id, **_upload_instructions(updated)})


# --- Upload instructions -----------------------------------------------------

def _upload_instructions(item):
    base = {"attemptId": item["attemptId"], "status": "pending"}

    if item["uploadMode"] == "multipart":
        return {
            **base,
            "upload": {
                "mode": "multipart",
                "partSize": int(item["partSize"]),
                "partCount": int(item["partCount"]),
            },
        }

    # Same S3-enforced SHA-256 pairing as presign-firmware, plus an exact
    # content-length-range and the pending tag.
    checksum_b64 = _sha256_hex_to_base64(item["sha256"])
    size = int(item["sizeBytes"])
    presigned = s3.generate_presigned_post(
        Bucket=item["s3Bucket"],
        Key=item["s3Key"],
        Fields={
            "Content-Type": CONTENT_TYPE,
            "x-amz-checksum-algorithm": "SHA256",
            "x-amz-checksum-sha256": checksum_b64,
            "tagging": PENDING_TAGGING_XML,
        },
        Conditions=[
            {"Content-Type": CONTENT_TYPE},
            {"x-amz-checksum-algorithm": "SHA256"},
            {"x-amz-checksum-sha256": checksum_b64},
            {"tagging": PENDING_TAGGING_XML},
            ["content-length-range", size, size],
        ],
        ExpiresIn=PRESIGN_EXPIRES_SEC,
    )
    return {
        **base,
        "upload": {"mode": "single", "url": presigned["url"], "fields": presigned["fields"]},
    }


def _create_multipart_upload(s3_key):
    return s3.create_multipart_upload(
        Bucket=BUCKET,
        Key=s3_key,
        ContentType=CONTENT_TYPE,
        ChecksumAlgorithm="SHA256",
        Tagging=PENDING_TAGGING,
    )["UploadId"]


def _abort_multipart_upload(s3_key, upload_id):
    try:
        s3.abort_multipart_upload(Bucket=BUCKET, Key=s3_key, UploadId=upload_id)
    except ClientError as e:
        # The lifecycle rule aborts anything left behind after a day.
        print(json.dumps({
            "event": "abort_multipart_upload_failed",
            "s3Key": s3_key,
            "code": e.response["Error"]["Code"],
        }))


def _part_size(size):
    mib = 1024 ** 2
    part_size = max(MIN_PART_SIZE, -(-size // MAX_PARTS))
    return -(-part_size // mib) * mib


# --- Validation --------------------------------------------------------------

def _validate_file(raw):
    if not isinstance(raw, dict):
        raise RequestError(400, "Each file must be an object")

    original_filename = raw.get("originalFilename")
    if not isinstance(original_filename, str) or not original_filename.strip():
        raise RequestError(400, "originalFilename is required")
    original_filename = original_filename.strip()
    if len(original_filename) > MAX_FILENAME_LENGTH or _has_control_chars(original_filename):
        raise RequestError(400, "originalFilename is invalid")

    name = raw.get("name")
    if name is None:
        name = original_filename.rsplit("/", 1)[-1][:MAX_NAME_LENGTH]
    if not isinstance(name, str) or not name.strip():
        raise RequestError(400, "name must be a non-empty string")
    name = name.strip()
    if len(name) > MAX_NAME_LENGTH or _has_control_chars(name):
        raise RequestError(400, "name is invalid")

    size_bytes = raw.get("sizeBytes")
    if not _is_int(size_bytes) or size_bytes <= 0:
        raise RequestError(400, "sizeBytes must be a positive integer")
    if size_bytes > MAX_ARTIFACT_SIZE_BYTES:
        raise RequestError(400, f"sizeBytes exceeds maximum of {MAX_ARTIFACT_SIZE_BYTES} bytes")

    sha256 = raw.get("sha256")
    if not isinstance(sha256, str) or not SHA256_PATTERN.match(sha256):
        raise RequestError(400, "sha256 must be a 64-character lowercase hex string")

    artifact_type = raw.get("type")
    if artifact_type not in ARTIFACT_TYPES:
        raise RequestError(400, f"type must be one of: {', '.join(sorted(ARTIFACT_TYPES))}")

    version = raw.get("version")
    if artifact_type == "firmware":
        if not isinstance(version, str) or not VERSION_PATTERN.match(version.strip()):
            raise RequestError(400, "Firmware needs a version (letters, digits, '.', '_' or '-')")
        version = version.strip()
    elif version is not None:
        raise RequestError(400, "version is only allowed for firmware")

    return {
        "originalFilename": original_filename,
        "name": name,
        "sizeBytes": size_bytes,
        "sha256": sha256,
        "type": artifact_type,
        "version": version,
    }


def _validate_tags(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_TAGS:
        raise RequestError(400, f"tags must be a list of at most {MAX_TAGS} strings")
    tags = []
    for tag in raw:
        if not isinstance(tag, str) or not TAG_PATTERN.match(tag.strip()):
            raise RequestError(400, f"Invalid tag: {tag!r}")
        if tag.strip() not in tags:
            tags.append(tag.strip())
    return tags


def _resolve_devices(table, user_id, raw):
    """Returns {deviceId: deviceName} for devices the caller owns."""
    if raw is None:
        return {}
    if not isinstance(raw, list) or len(raw) > MAX_DEVICES:
        raise RequestError(400, f"deviceIds must be a list of at most {MAX_DEVICES} ids")

    devices = {}
    for device_id in raw:
        if _validate_uuid(device_id) is None:
            raise RequestError(400, "deviceIds contains an invalid id")
        if device_id in devices:
            continue
        link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
        if link is None or link.get("role") != "owner":
            raise RequestError(403, f"Not authorized for device {device_id}")
        devices[device_id] = link.get("name") or device_id
    return devices


def _resolve_batch(table, user_id, raw):
    """Returns an upload batch id, creating the batch when none is given."""
    if raw is not None:
        batch_id = _validate_uuid(raw)
        if batch_id is None:
            raise RequestError(400, "uploadBatchId is invalid")
        link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"BATCH#{batch_id}"}).get("Item")
        if link is None or link.get("role") != "owner":
            raise RequestError(404, "Upload batch not found")
        return batch_id

    batch_id = _uuid7()
    now = _now()
    client.transact_write_items(TransactItems=[
        _put({
            "pk": f"BATCH#{batch_id}", "sk": "METADATA", "entity": "upload-batch",
            "uploadBatchId": batch_id, "fileCount": 0, "totalBytes": 0,
            "createdBy": user_id, "createdAt": now, "updatedAt": now,
        }),
        _put({
            "pk": f"USER#{user_id}", "sk": f"BATCH#{batch_id}", "entity": "user-batch",
            "role": "owner", "createdAt": now,
        }),
        _put({
            "pk": f"BATCH#{batch_id}", "sk": f"USER#{user_id}", "entity": "batch-user",
            "role": "owner",
        }),
    ])
    return batch_id


def _get_owned_artifact(table, user_id, artifact_id):
    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"ARTIFACT#{artifact_id}"}).get("Item")
    if link is None or link.get("role") != "owner":
        raise RequestError(404, "Artifact not found")
    item = table.get_item(Key={"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}).get("Item")
    if item is None:
        raise RequestError(404, "Artifact not found")
    return item


def _client_ref(raw, index):
    ref = raw.get("clientRef") if isinstance(raw, dict) else None
    if isinstance(ref, str) and 0 < len(ref) <= MAX_CLIENT_REF_LENGTH:
        return ref
    return str(index)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _has_control_chars(value):
    return any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value)


def _validate_uuid(raw):
    if not isinstance(raw, str) or not UUID_PATTERN.match(raw):
        return None
    return raw


# --- Helpers -----------------------------------------------------------------

def _uuid7():
    # Time-ordered UUID (RFC 9562 version 7), so ARTIFACT#/BATCH# sort keys
    # list newest-first with ScanIndexForward=False.
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _build_s3_key(artifact_id, attempt_id):
    return f"artifacts/{artifact_id}/{attempt_id}"


def _sha256_hex_to_base64(sha256_hex):
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _put(item):
    return {
        "Put": {
            "TableName": TABLE,
            "Item": {k: serializer.serialize(v) for k, v in item.items()},
            "ConditionExpression": "attribute_not_exists(pk)",
        }
    }


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
