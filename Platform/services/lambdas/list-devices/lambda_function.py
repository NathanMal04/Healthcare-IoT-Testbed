import json
import os
import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

DEVICE_SK_PREFIX = "DEVICE#"


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    table = dynamodb.Table(TABLE)
    result = table.query(
        KeyConditionExpression=(
            Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with(DEVICE_SK_PREFIX)
        )
    )

    devices = [
        {
            "deviceId": item["sk"][len(DEVICE_SK_PREFIX):],
            "name": item.get("name"),
            "role": item.get("role"),
        }
        for item in result.get("Items", [])
    ]

    return _resp(200, {"devices": devices})


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
