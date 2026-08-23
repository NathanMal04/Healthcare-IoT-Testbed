import json
import os
import re
import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

FIRMWARE_SK_PREFIX = "FIRMWARE#"

# create-device generates deviceId via str(uuid.uuid4()) — this is the
# canonical lowercase, hyphenated form that produces. Matching it exactly
# makes that API contract explicit rather than accepting any string.
DEVICE_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    device_id = _validate_device_id((event.get("pathParameters") or {}).get("deviceId"))

    if device_id is None:
        return _resp(400, {"error": "deviceId is invalid or missing"})

    table = dynamodb.Table(TABLE)

    # Read access only requires an existing USER->DEVICE relationship, not
    # specifically role == "owner". Every relationship created by this
    # repository today has role "owner" (create-device is the only writer of
    # user-device items), so this behaves identically to owner-only in
    # practice, but doesn't need to change if a non-owner read role (e.g.
    # "viewer") is introduced later — that's the least surprising choice
    # given mutation endpoints are explicitly owner-gated but nothing in the
    # repository ties read access to a specific role.
    if not _has_relationship(table, user_id, device_id):
        return _resp(403, {"error": "Not authorized for this device"})

    result = table.query(
        KeyConditionExpression=(
            Key("pk").eq(f"DEVICE#{device_id}") & Key("sk").begins_with(FIRMWARE_SK_PREFIX)
        )
    )

    firmware = [_public_view(item) for item in result.get("Items", [])]

    return _resp(200, {"firmware": firmware})


def _public_view(item):
    # Excludes pk/sk/entity (internal DynamoDB representation, redundant
    # with deviceId + version), attemptId/s3Bucket/s3Key (internal
    # concurrency/storage details a list view has no use for and shouldn't
    # tempt a frontend into misusing), createdBy (a raw Cognito sub), and
    # updatedAt (bookkeeping not needed alongside createdAt/uploadedAt).
    return {
        "firmwareId": item.get("firmwareId"),
        "version": item.get("version"),
        "status": item.get("status"),
        "originalFilename": item.get("originalFilename"),
        "sizeBytes": int(item["sizeBytes"]) if item.get("sizeBytes") is not None else None,
        "sha256": item.get("sha256"),
        "createdAt": item.get("createdAt"),
        "uploadedAt": item.get("uploadedAt"),
    }


def _has_relationship(table, user_id, device_id):
    item = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
    return item is not None


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
