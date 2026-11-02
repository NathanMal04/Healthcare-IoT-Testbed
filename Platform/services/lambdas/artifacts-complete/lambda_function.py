import base64
import json
import os
import re
import boto3
import image_fields
import testbed_authz
from datetime import datetime, timedelta, timezone
from botocore.exceptions import BotoCoreError, ClientError

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
PENDING_TAGSET = [{"Key": "upload-state", "Value": "pending"}]
# S3 errors worth retrying (throttling, server-side failures) when reading an
# image's first bytes; the image stays pending and complete can be called again.
TRANSIENT_S3_ERRORS = {"SlowDown", "ServiceUnavailable", "InternalError", "RequestTimeout", "500", "503"}

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

    if event.get("resource") == "/artifacts/{artifactId}/replacement/complete":
        return _handle_replacement_complete(user_id, event, body)

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
    # The owner of a personal artifact, or any member of a workspace
    # artifact's workspace; 404 otherwise so ids aren't revealed.
    try:
        item = testbed_authz.require_resource(table, user_id, "ARTIFACT", artifact_id, legacy_roles=("owner",))
    except testbed_authz.AuthorizationError:
        raise ItemError(404, "Artifact not found")

    key = {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}

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
    if item.get("type") == image_fields.IMAGE_TYPE and item.get("uploadMode") != "single":
        # artifacts-presign only issues single uploads for images; only that
        # path checks the image signature, so anything else is refused.
        _mark_failed(table, key, item, "Images must be uploaded in a single request")
        raise ItemError(422, "Images must be uploaded in a single request")
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

    if item.get("type") == image_fields.IMAGE_TYPE:
        problem = _image_problem(item, head)
        if problem:
            # Not committed: the object keeps its pending tag, so the
            # lifecycle rule deletes it.
            _mark_failed(table, key, item, problem)
            raise ItemError(422, problem)

    _commit_object(item)
    return _transition(table, key, item, "pending", "ready", uploaded=True)


def _image_problem(item, head):
    """Why a completed image upload is unacceptable, or None.

    S3 already confirmed the size and SHA-256. This checks that the object is
    stored with the declared image MIME type (the presigned POST policy pins
    it) and that its first bytes are that format's file signature, so a file
    of another kind (an SVG, HTML, an executable...) can't become an image
    that is later served inline.
    """
    mime_type = item.get("mimeType")
    if mime_type not in image_fields.IMAGE_MIME_TYPES:
        return "Unsupported image type"
    if head.get("ContentType") != mime_type:
        return f"Uploaded object is not stored as {mime_type}"
    try:
        start = s3.get_object(
            Bucket=item["s3Bucket"],
            Key=item["s3Key"],
            Range=f"bytes=0-{image_fields.SIGNATURE_BYTES - 1}",
        )["Body"]
        try:
            head_bytes = start.read()
        finally:
            start.close()
    except ClientError as e:
        # As for HeadObject: the artifact stays pending, so the client can
        # call complete again (or retry the upload).
        code = e.response["Error"]["Code"]
        if code in ("404", "NoSuchKey", "403"):
            raise ItemError(409, "Uploaded object not found yet; retry once the upload has completed")
        if code in TRANSIENT_S3_ERRORS:
            raise ItemError(409, "Could not read the uploaded object; retry completing the upload")
        raise
    except BotoCoreError:
        # Connection or streaming failure while reading the first bytes.
        raise ItemError(409, "Could not read the uploaded object; retry completing the upload")
    if not image_fields.matches_signature(mime_type, head_bytes):
        return f"Uploaded file is not a valid {mime_type} image"
    return None


# --- POST /artifacts/{artifactId}/replacement/complete -------------------------

def _handle_replacement_complete(user_id, event, body):
    """Verifies a replacement image (artifacts-presign started it) and swaps
    it in, keeping the artifact, then permanently deletes the old object.

    Order, so the artifact never points at a missing or unverified file:
    1. verify the new object exactly like a first image upload (size and
       SHA-256 from S3's checksum, stored Content-Type, file signature);
    2. tag it committed, so the lifecycle rule never expires it;
    3. swap the record to it in one conditional write, which also moves the
       old key to `orphanS3Keys`;
    4. delete every orphaned key that isn't live or in flight.
    If verification fails, the old file stays live and untouched. A repeated
    call for a replacement that is already live only retries the cleanup.
    """
    artifact_id = (event.get("pathParameters") or {}).get("artifactId")
    if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
        return _resp(400, {"error": "artifactId is invalid or missing"})
    replacement_id = body.get("replacementId")
    if not isinstance(replacement_id, str) or not UUID_PATTERN.match(replacement_id):
        return _resp(400, {"error": "replacementId is invalid or missing"})

    table = dynamodb.Table(TABLE)
    # Same rule as starting it (and as PATCH): owner of a personal image, any
    # member of a workspace image's workspace; 404 otherwise.
    try:
        item = testbed_authz.require_resource(table, user_id, "ARTIFACT", artifact_id, legacy_roles=("owner",))
    except testbed_authz.AuthorizationError:
        return _resp(404, {"error": "Artifact not found"})
    if item.get("type") != image_fields.IMAGE_TYPE:
        return _resp(400, {"error": "Only image artifacts can be replaced"})

    key = {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}
    # The authorization read is eventually consistent; decide on a strongly
    # consistent one, so a just-started replacement is never missed.
    item = _read(table, key) or item
    try:
        swapped = _replace(table, key, item, replacement_id)
    except ItemError as e:
        # A rejected or superseded upload may just have been recorded as
        # orphaned: remove it now rather than at the next replacement.
        # Cleanup only ever touches keys that can't go live, so it is safe
        # on every path, and best-effort, so it never hides this answer.
        _cleanup_best_effort(table, key, artifact_id)
        return _resp(e.status, {"error": e.message})

    # The replacement is live from here on: nothing below may turn that into
    # an error, or the client would believe the old file was kept.
    pending = _cleanup_best_effort(table, key, artifact_id)
    try:
        current = _read(table, key) or swapped
    except (ClientError, BotoCoreError):
        current = swapped
    return _resp(200, {
        "artifactId": artifact_id,
        "replacementId": replacement_id,
        "image": _replaced_image(current),
        # The old file couldn't be deleted yet: it stays tracked in
        # orphanS3Keys (retried by later calls) and is tagged for expiry.
        "cleanupPending": pending,
    })


def _replace(table, key, item, replacement_id):
    """Swaps the replacement in and returns the record, or raises ItemError."""
    if item["attemptId"] == replacement_id:
        # Already live: a repeated call, or a concurrent one got here first.
        return item

    replacement = item.get("replacement")
    if not replacement or replacement.get("replacementId") != replacement_id:
        # Superseded by a newer replacement, or failed verification earlier.
        # Its object (if the upload landed after all) is never live: track it.
        _add_orphan(table, key, _replacement_key(item, replacement_id), replacement_id)
        raise ItemError(409, "This replacement is no longer current (another replacement was started, or it "
                             "failed); start again")
    if item.get("status") != "ready":
        raise ItemError(409, f"Artifact is {item.get('status')}, not ready")

    candidate = {**item, "s3Key": replacement["s3Key"], "mimeType": replacement["mimeType"]}
    try:
        head = s3.head_object(Bucket=item["s3Bucket"], Key=replacement["s3Key"], ChecksumMode="ENABLED")
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("404", "NoSuchKey", "403"):
            raise ItemError(409, "Uploaded file not found yet; retry once the upload has completed")
        if code in TRANSIENT_S3_ERRORS:
            raise ItemError(409, "Could not read the uploaded file; try again")
        raise
    except BotoCoreError:
        raise ItemError(409, "Could not read the uploaded file; try again")

    expected_checksum = _sha256_hex_to_base64(replacement["sha256"])
    if head["ContentLength"] != int(replacement["sizeBytes"]) or head.get("ChecksumSHA256") != expected_checksum:
        problem = "Uploaded file does not match the declared size and SHA-256"
    else:
        # Raises ItemError(409) for a missing object or a transient read error.
        problem = _image_problem(candidate, head)
    if problem:
        _abandon_replacement(table, key, item, replacement)
        raise ItemError(422, f"{problem}; the current image was kept")

    _commit_object(candidate)
    now = _now()
    try:
        return table.update_item(
            Key=key,
            UpdateExpression=(
                "SET s3Key = :key, attemptId = :rid, sha256 = :sha, sizeBytes = :size, mimeType = :mime, "
                "originalFilename = :filename, uploadedAt = :now, updatedAt = :now "
                "REMOVE #rep ADD orphanS3Keys :old"
            ),
            ConditionExpression="attemptId = :expected AND #st = :ready AND #rep.#rid = :rid",
            ExpressionAttributeNames={"#st": "status", "#rep": "replacement", "#rid": "replacementId"},
            ExpressionAttributeValues={
                ":key": replacement["s3Key"],
                ":rid": replacement_id,
                ":sha": replacement["sha256"],
                ":size": replacement["sizeBytes"],
                ":mime": replacement["mimeType"],
                ":filename": replacement["originalFilename"],
                ":now": now,
                ":old": {item["s3Key"]},
                ":expected": item["attemptId"],
                ":ready": "ready",
            },
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    refreshed = _read(table, key)
    if refreshed and refreshed["attemptId"] == replacement_id:
        return refreshed  # a concurrent call swapped it in
    # Superseded while it was being verified: the new object never went live.
    _add_orphan(table, key, replacement["s3Key"], replacement_id)
    raise ItemError(409, "Another replacement was started at the same time; start again")


def _abandon_replacement(table, key, item, replacement):
    """Clears a replacement that failed verification; its object is orphaned."""
    try:
        table.update_item(
            Key=key,
            UpdateExpression="REMOVE #rep ADD orphanS3Keys :orphan",
            ConditionExpression="#rep.#rid = :rid",
            ExpressionAttributeNames={"#rep": "replacement", "#rid": "replacementId"},
            ExpressionAttributeValues={":rid": replacement["replacementId"], ":orphan": {replacement["s3Key"]}},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # Already superseded, and the newer request recorded this key.


def _replacement_key(item, replacement_id):
    # Same layout as artifacts-presign; replacement_id is a validated UUID.
    return f"artifacts/{item['artifactId']}/{replacement_id}"


def _add_orphan(table, key, s3_key, replacement_id):
    """Records the object of a replacement that can no longer go live.

    Every write that adds to orphanS3Keys is conditional on the key being
    unable to become live: here, the replacement is neither live nor the
    pending one (only the pending one can be swapped in), checked on the
    write itself, so a stale read can never get a live key deleted.
    """
    try:
        table.update_item(
            Key=key,
            UpdateExpression="ADD orphanS3Keys :orphan",
            ConditionExpression=(
                "attribute_exists(pk) AND attemptId <> :rid "
                "AND (attribute_not_exists(#rep) OR #rep.#rid <> :rid)"
            ),
            ExpressionAttributeNames={"#rep": "replacement", "#rid": "replacementId"},
            ExpressionAttributeValues={":orphan": {s3_key}, ":rid": replacement_id},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # It became live or pending after all: not an orphan.


def _read(table, key):
    return table.get_item(Key=key, ConsistentRead=True).get("Item")


def _cleanup_orphans(table, key, artifact_id):
    """Permanently deletes the artifact's orphaned objects; returns the keys
    that couldn't be deleted (they stay in orphanS3Keys for a later call).

    The bucket is unversioned, so DeleteObject removes the bytes for good. A
    key is never deleted while it is the live s3Key or the pending
    replacement's key, and only keys under this artifact's own prefix are
    touched. Keys are unique per upload attempt and never reused, so an
    orphaned key can't become live again.
    """
    item = _read(table, key)
    if not item:
        return []
    protected = {item.get("s3Key"), (item.get("replacement") or {}).get("s3Key")}
    prefix = f"artifacts/{artifact_id}/"
    pending = []
    for orphan in sorted(item.get("orphanS3Keys") or ()):
        if orphan in protected or not orphan.startswith(prefix):
            print(json.dumps({"event": "orphan_cleanup_skipped", "artifactId": artifact_id, "s3Key": orphan}))
            continue
        try:
            s3.delete_object(Bucket=item["s3Bucket"], Key=orphan)
        except (ClientError, BotoCoreError) as e:
            code = e.response["Error"]["Code"] if isinstance(e, ClientError) else type(e).__name__
            print(json.dumps({"event": "orphan_delete_failed", "artifactId": artifact_id, "s3Key": orphan,
                              "code": code}))
            _tag_for_expiry(item["s3Bucket"], orphan)
            pending.append(orphan)
            continue
        table.update_item(
            Key=key,
            UpdateExpression="DELETE orphanS3Keys :orphan",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":orphan": {orphan}},
        )
    return pending


def _cleanup_best_effort(table, key, artifact_id):
    """_cleanup_orphans, never raising. Returns whether cleanup is still
    pending: keys that couldn't be deleted, or a cleanup that failed itself
    (e.g. DynamoDB throttling). Either way the keys stay in orphanS3Keys, so
    a later call retries them."""
    try:
        return bool(_cleanup_orphans(table, key, artifact_id))
    except (ClientError, BotoCoreError) as e:
        code = e.response["Error"]["Code"] if isinstance(e, ClientError) else type(e).__name__
        print(json.dumps({"event": "orphan_cleanup_failed", "artifactId": artifact_id, "code": code}))
        return True


def _tag_for_expiry(bucket, s3_key):
    # Fallback for a failed delete: the lifecycle rule expires pending-tagged
    # objects 7 days after they were created, so an old file goes within a
    # day of this even if no later call retries the delete.
    try:
        s3.put_object_tagging(Bucket=bucket, Key=s3_key, Tagging={"TagSet": PENDING_TAGSET})
    except (ClientError, BotoCoreError):
        pass


def _replaced_image(item):
    return {
        "artifactId": item["artifactId"],
        "attemptId": item["attemptId"],
        "status": item.get("status"),
        "sha256": item.get("sha256"),
        "sizeBytes": int(item["sizeBytes"]) if item.get("sizeBytes") is not None else None,
        "originalFilename": item.get("originalFilename"),
        "uploadedAt": item.get("uploadedAt"),
        **image_fields.public_fields(item),
    }


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
