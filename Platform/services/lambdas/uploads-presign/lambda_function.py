import json
import os
import uuid
import boto3
from datetime import datetime, timezone

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

BUCKET = os.environ["DATA_LAKE_BUCKET"]
TABLE = os.environ["METADATA_TABLE_NAME"]
EXPIRES = int(os.environ.get("PRESIGN_EXPIRES_SEC", "300"))


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    body = json.loads(event.get("body") or "{}")
    device_id = body.get("deviceId")
    version = body.get("version")
    filename = body.get("filename")
    file_size = body.get("fileSize")
    content_type = body.get("contentType") or "application/octet-stream"

    if not all([device_id, version, filename]):
        return _resp(400, {"error": "deviceId, version, and filename are required"})

    upload_id = str(uuid.uuid4())
    s3_key = f"devices/{device_id}/{version}/{upload_id}-{filename}"
    now = datetime.now(timezone.utc).isoformat()

    table = dynamodb.Table(TABLE)
    table.put_item(Item={
        "pk": f"USER#{user_id}",
        "sk": f"UPLOAD#{upload_id}",
        "entity": "upload",
        "status": "pending",
        "deviceId": device_id,
        "version": version,
        "filename": filename,
        "s3Key": s3_key,
        "fileSize": file_size,
        "contentType": content_type,
        "createdAt": now,
        "updatedAt": now,
    })

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": BUCKET,
            "Key": s3_key,
            "ContentType": content_type,
        },
        ExpiresIn=EXPIRES,
    )

    return _resp(200, {
        "uploadId": upload_id,
        "presignedUrl": presigned_url,
        "s3Key": s3_key,
        "expiresIn": EXPIRES,
    })


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }