import json
import os
import uuid
import boto3
from datetime import datetime, timezone
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]

REQUIRED_FIELDS = ["name", "type"]


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})

    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    values = {}
    for field in REQUIRED_FIELDS:
        raw = body.get(field)
        if not isinstance(raw, str) or not raw.strip():
            return _resp(400, {"error": f"{field} is required"})
        values[field] = raw.strip()

    device_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    data_path = f"s3://{BUCKET}/devices/{device_id}/"

    device_item = {
        "pk": f"DEVICE#{device_id}",
        "sk": "METADATA",
        "entity": "device",
        "name": values["name"],
        "type": values["type"],
        "status": "active",
        "dataPath": data_path,
        "createdAt": now,
        "updatedAt": now,
    }

    user_device_item = {
        "pk": f"USER#{user_id}",
        "sk": f"DEVICE#{device_id}",
        "entity": "user-device",
        "role": "owner",
        "name": values["name"],
    }

    device_user_item = {
        "pk": f"DEVICE#{device_id}",
        "sk": f"USER#{user_id}",
        "entity": "device-user",
        "role": "owner",
    }

    try:
        client.transact_write_items(
            TransactItems=[
                _put(device_item),
                _put(user_device_item),
                _put(device_user_item),
            ]
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            reasons = e.response.get("CancellationReasons", [])
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                return _resp(409, {"error": "Device already exists"})
            print(json.dumps({
                "event": "create_device_transaction_canceled",
                "deviceId": device_id,
                "message": e.response["Error"].get("Message"),
                "cancellationReasons": [
                    {"code": r.get("Code"), "message": r.get("Message")}
                    for r in reasons
                ],
            }))
            return _resp(500, {"error": "Failed to create device"})
        raise

    return _resp(
        201,
        {
            "deviceId": device_id,
            "name": values["name"],
            "type": values["type"],
            "status": "active",
            "dataPath": data_path,
            "createdAt": now,
            "updatedAt": now,
        },
    )


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
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
