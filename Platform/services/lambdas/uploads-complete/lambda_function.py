import json
import os
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

BUCKET = os.environ["DATA_LAKE_BUCKET"]
TABLE  = os.environ["METADATA_TABLE_NAME"]


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    body      = json.loads(event.get("body") or "{}")
    upload_id = body.get("uploadId")

    if not upload_id:
        return _resp(400, {"error": "uploadId is required"})

    table = dynamodb.Table(TABLE)
    pk    = f"USER#{user_id}"
    sk    = f"UPLOAD#{upload_id}"

    result = table.get_item(Key={"pk": pk, "sk": sk})
    item   = result.get("Item")

    if not item:
        return _resp(404, {"error": "Upload not found"})

    if item["status"] != "pending":
        return _resp(409, {"error": f"Upload is already {item['status']}"})

    s3_key = item["s3Key"]

    try:
        head = s3.head_object(Bucket=BUCKET, Key=s3_key)
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return _resp(422, {"error": "File not found in S3 — upload may not have completed"})
        raise

    now = datetime.now(timezone.utc).isoformat()

    table.update_item(
        Key={"pk": pk, "sk": sk},
        UpdateExpression=(
            "SET #st = :s, uploadedAt = :ua, updatedAt = :now, contentLength = :cl"
        ),
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={
            ":s":  "complete",
            ":ua": now,
            ":now": now,
            ":cl": str(head["ContentLength"]),
        },
        ConditionExpression="attribute_exists(pk)",
    )

    return _resp(200, {
        "uploadId": upload_id,
        "s3Key":    s3_key,
        "status":   "complete",
    })


def _resp(status, body):
    return {
        "statusCode": status,
        "headers":    {"Content-Type": "application/json"},
        "body":       json.dumps(body),
    }
