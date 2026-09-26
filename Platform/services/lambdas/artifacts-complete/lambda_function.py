import base64
import json
import os
import re
import boto3
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
VERIFY_FUNCTION_NAME = os.environ["VERIFY_FUNCTION_NAME"]
# A multipart upload that has sat in "verifying" this long is assumed to have
# lost its verify invocation, and a repeat complete call re-invokes it.
VERIFY_STALE_SEC = int(os.environ.get("VERIFY_STALE_SEC", "1200"))

MAX_ITEMS_PER_REQUEST = 100
COMMITTED_TAGSET = [{"Key": "upload-state", "Value": "committed"}]

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class ItemError(Exception):
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

    items = body.get("items")
    if not isinstance(items, list) or not items:
        return _resp(400, {"error": "items must be a non-empty list"})
    if len(items) > MAX_ITEMS_PER_REQUEST:
        return _resp(400, {"error": f"At most {MAX_ITEMS_PER_REQUEST} items per request"})

    table = dynamodb.Table(TABLE)
    results = []
    for raw in items:
        artifact_id = raw.get("artifactId") if isinstance(raw, dict) else None
        try:
            if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
                raise ItemError(400, "artifactId is invalid or missing")
            attempt_id = raw.get("attemptId")
            if not isinstance(attempt_id, str) or not attempt_id:
                raise ItemError(400, "attemptId is required")
            item = _complete(table, user_id, artifact_id, attempt_id)
        except ItemError as e:
            results.append({"artifactId": artifact_id, "ok": False, "status": e.status, "error": e.message})
            continue
        results.append({"artifactId": artifact_id, "ok": True, **_public_status(item)})

    return _resp(200, {"results": results})


def _complete(table, user_id, artifact_id, attempt_id):
    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"ARTIFACT#{artifact_id}"}).get("Item")
    if link is None or link.get("role") != "owner":
        raise ItemError(404, "Artifact not found")

    key = {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}
    item = table.get_item(Key=key).get("Item")
    if item is None:
        raise ItemError(404, "Artifact not found")

    if item["attemptId"] != attempt_id:
        raise ItemError(409, "Upload attempt is no longer current")

    status = item["status"]
    if status == "ready":
        return item
    if status == "failed":
        raise ItemError(409, f"Upload failed ({item.get('statusReason', 'unknown reason')}); retry it")
    if status == "verifying":
        if _is_stale(item):
            _invoke_verify(artifact_id, attempt_id)
        return item

    # status == "pending"
    if item.get("uploadMode") == "multipart":
        return _complete_multipart(table, key, item)
    return _complete_single(table, key, item)


def _complete_single(table, key, item):
    # Same verification as complete-firmware: S3 checked the bytes against
    # the declared SHA-256 at upload time, so a matching size and a matching
    # stored checksum mean the object is exactly the declared file.
    try:
        head = s3.head_object(Bucket=item["s3Bucket"], Key=item["s3Key"], ChecksumMode="ENABLED")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "403"):
            # A bare 403 is what HeadObject returns for a missing key without
            # s3:ListBucket, which is deliberately not granted.
            raise ItemError(409, "Uploaded object not found yet; retry once the upload has completed")
        raise

    expected_checksum = _sha256_hex_to_base64(item["sha256"])
    if head["ContentLength"] != int(item["sizeBytes"]) or head.get("ChecksumSHA256") != expected_checksum:
        _mark_failed(table, key, item, "Uploaded object does not match the declared size and SHA-256")
        raise ItemError(422, "Uploaded object does not match the declared size and SHA-256")

    _commit_object(item)
    return _transition(table, key, item, "pending", "ready", uploaded=True)


def _complete_multipart(table, key, item):
    part_size = int(item["partSize"])
    part_count = int(item["partCount"])
    size = int(item["sizeBytes"])

    try:
        parts = _list_parts(item)
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchUpload":
            raise
        # A concurrent complete call may already have finished the upload.
        refreshed = table.get_item(Key=key).get("Item")
        if refreshed and refreshed["attemptId"] == item["attemptId"] and refreshed["status"] != "pending":
            return refreshed
        raise ItemError(409, "The multipart upload no longer exists; retry the upload")

    missing = [n for n in range(1, part_count + 1) if n not in parts]
    if missing:
        raise ItemError(409, f"{len(missing)} of {part_count} parts have not been uploaded yet")

    for number in range(1, part_count + 1):
        expected_size = part_size if number < part_count else size - part_size * (part_count - 1)
        part = parts[number]
        if part["Size"] != expected_size or not part.get("ChecksumSHA256"):
            _mark_failed(table, key, item, f"Part {number} has the wrong size or no checksum")
            raise ItemError(422, f"Part {number} has the wrong size or no checksum")

    try:
        s3.complete_multipart_upload(
            Bucket=item["s3Bucket"],
            Key=item["s3Key"],
            UploadId=item["uploadId"],
            MultipartUpload={
                "Parts": [
                    {
                        "PartNumber": n,
                        "ETag": parts[n]["ETag"],
                        "ChecksumSHA256": parts[n]["ChecksumSHA256"],
                    }
                    for n in range(1, part_count + 1)
                ]
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchUpload":
            raise
        refreshed = table.get_item(Key=key).get("Item")
        if refreshed and refreshed["attemptId"] == item["attemptId"] and refreshed["status"] != "pending":
            return refreshed
        raise ItemError(409, "The multipart upload no longer exists; retry the upload")

    # S3 can only attest per-part SHA-256 for multipart objects, so the
    # full-file hash is checked asynchronously by artifacts-verify.
    updated = _transition(table, key, item, "pending", "verifying")
    _invoke_verify(item["artifactId"], item["attemptId"])
    return updated


def _list_parts(item):
    parts = {}
    kwargs = {"Bucket": item["s3Bucket"], "Key": item["s3Key"], "UploadId": item["uploadId"], "MaxParts": 1000}
    while True:
        page = s3.list_parts(**kwargs)
        for part in page.get("Parts", []):
            parts[part["PartNumber"]] = part
        if not page.get("IsTruncated"):
            return parts
        kwargs["PartNumberMarker"] = page["NextPartNumberMarker"]


def _transition(table, key, item, from_status, to_status, uploaded=False):
    now = _now()
    update = "SET #st = :to, statusUpdatedAt = :now, updatedAt = :now"
    if uploaded:
        update += ", uploadedAt = :now"
    try:
        return table.update_item(
            Key=key,
            UpdateExpression=update,
            ConditionExpression="attemptId = :expected AND #st = :from",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":to": to_status,
                ":from": from_status,
                ":expected": item["attemptId"],
                ":now": now,
            },
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # Lost a race with another complete or retry: report the record as it
        # is now, rather than assuming our result still applies.
        refreshed = table.get_item(Key=key).get("Item")
        if refreshed and refreshed["attemptId"] == item["attemptId"] and refreshed["status"] in ("verifying", "ready"):
            return refreshed
        raise ItemError(409, "Upload attempt is no longer current")


def _mark_failed(table, key, item, reason):
    now = _now()
    try:
        table.update_item(
            Key=key,
            UpdateExpression="SET #st = :failed, statusReason = :reason, statusUpdatedAt = :now, updatedAt = :now",
            ConditionExpression="attemptId = :expected AND #st = :pending",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":failed": "failed",
                ":pending": "pending",
                ":reason": reason,
                ":expected": item["attemptId"],
                ":now": now,
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise ItemError(409, "Upload attempt is no longer current")


def _commit_object(item):
    # Clears the "pending" tag so the lifecycle rule never expires the object.
    s3.put_object_tagging(Bucket=item["s3Bucket"], Key=item["s3Key"], Tagging={"TagSet": COMMITTED_TAGSET})


def _invoke_verify(artifact_id, attempt_id):
    lambda_client.invoke(
        FunctionName=VERIFY_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({"artifactId": artifact_id, "attemptId": attempt_id}).encode("utf-8"),
    )


def _is_stale(item):
    updated = item.get("statusUpdatedAt")
    if not updated:
        return True
    try:
        updated_at = datetime.fromisoformat(updated)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - updated_at > timedelta(seconds=VERIFY_STALE_SEC)


def _public_status(item):
    return {
        "attemptId": item["attemptId"],
        "status": item["status"],
        "statusReason": item.get("statusReason"),
        "uploadedAt": item.get("uploadedAt"),
    }


def _sha256_hex_to_base64(sha256_hex):
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
