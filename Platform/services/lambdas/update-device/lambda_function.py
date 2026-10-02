import json
import os
import re
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

# reverseEngineeringStatus is separate from the device's lifecycle "status"
# (always "active"), which this endpoint never touches.
RE_STATUSES = ("not_started", "in_progress", "complete")
UPDATABLE_FIELDS = {"reverseEngineeringStatus"}

# create-device generates deviceId via str(uuid.uuid4()) — this is the
# canonical lowercase, hyphenated form that produces. Matching it exactly
# makes that API contract explicit rather than accepting any string.
DEVICE_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def handler(event, context):
    """PATCH /devices/{deviceId} with {"reverseEngineeringStatus": ...}."""
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

    # Same rule as the other device mutation endpoints (presign-firmware,
    # complete-firmware, artifacts-presign): only an owner may change it.
    if not _is_owner(table, user_id, device_id):
        return _resp(403, {"error": "Not authorized for this device"})

    unsupported = sorted(set(body) - UPDATABLE_FIELDS)
    if unsupported:
        return _resp(400, {"error": f"Unsupported field(s): {', '.join(unsupported)}"})

    status = body.get("reverseEngineeringStatus")
    if status not in RE_STATUSES:
        return _resp(400, {
            "error": f"reverseEngineeringStatus must be one of: {', '.join(RE_STATUSES)}"
        })

    now = datetime.now(timezone.utc).isoformat()

    # Only the canonical DEVICE#/METADATA record holds the status; the
    # USER#/DEVICE# link rows carry immutable display fields only. The
    # condition stops an update from creating a bare item if the metadata
    # record is missing.
    try:
        updated = table.update_item(
            Key={"pk": f"DEVICE#{device_id}", "sk": "METADATA"},
            UpdateExpression="SET reverseEngineeringStatus = :status, updatedAt = :now",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":status": status, ":now": now},
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"error": "Device not found"})
        raise

    return _resp(200, {
        "deviceId": device_id,
        "name": updated.get("name"),
        "reverseEngineeringStatus": updated["reverseEngineeringStatus"],
        "updatedAt": updated.get("updatedAt"),
    })


def _is_owner(table, user_id, device_id):
    item = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
    return item is not None and item.get("role") == "owner"


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
