import hashlib
import json
import os
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

CHUNK_SIZE = 8 * 1024 ** 2
COMMITTED_TAGSET = [{"Key": "upload-state", "Value": "committed"}]


def handler(event, context):
    """Invoked asynchronously by artifacts-complete with {artifactId, attemptId}.

    Streams a completed multipart object and checks its full SHA-256 against
    the one declared at presign time, then moves verifying -> ready or failed.
    Every write is conditional on the attempt still being current, so a
    duplicate or late invocation can't overwrite a newer attempt.
    """
    artifact_id = event.get("artifactId")
    attempt_id = event.get("attemptId")
    if not isinstance(artifact_id, str) or not isinstance(attempt_id, str):
        print(json.dumps({"event": "verify_bad_input", "input": event}))
        return

    table = dynamodb.Table(TABLE)
    key = {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}
    item = table.get_item(Key=key).get("Item")
    if item is None or item["attemptId"] != attempt_id or item["status"] != "verifying":
        print(json.dumps({"event": "verify_skipped", "artifactId": artifact_id, "attemptId": attempt_id}))
        return

    try:
        obj = s3.get_object(Bucket=item["s3Bucket"], Key=item["s3Key"])
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404", "403"):
            _finish(table, key, attempt_id, "failed", "Uploaded object is missing")
            return
        raise

    if obj["ContentLength"] != int(item["sizeBytes"]):
        obj["Body"].close()
        _finish(table, key, attempt_id, "failed", "Uploaded object has the wrong size")
        return

    digest = hashlib.sha256()
    for chunk in obj["Body"].iter_chunks(CHUNK_SIZE):
        digest.update(chunk)

    if digest.hexdigest() != item["sha256"]:
        _finish(table, key, attempt_id, "failed", "SHA-256 of the uploaded object does not match")
        return

    s3.put_object_tagging(Bucket=item["s3Bucket"], Key=item["s3Key"], Tagging={"TagSet": COMMITTED_TAGSET})
    _finish(table, key, attempt_id, "ready")


def _finish(table, key, attempt_id, status, reason=None):
    now = _now()
    update = "SET #st = :to, statusUpdatedAt = :now, updatedAt = :now"
    values = {":to": status, ":verifying": "verifying", ":expected": attempt_id, ":now": now}
    if status == "ready":
        update += ", uploadedAt = :now"
    if reason:
        update += ", statusReason = :reason"
        values[":reason"] = reason
    try:
        table.update_item(
            Key=key,
            UpdateExpression=update,
            ConditionExpression="attemptId = :expected AND #st = :verifying",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues=values,
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        print(json.dumps({"event": "verify_superseded", "key": key, "attemptId": attempt_id}))
        return
    print(json.dumps({"event": "verify_finished", "key": key, "status": status, "reason": reason}))


def _now():
    return datetime.now(timezone.utc).isoformat()
