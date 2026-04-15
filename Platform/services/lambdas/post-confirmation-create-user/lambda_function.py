import os
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")


def handler(event, context):
    attrs = event.get("request", {}).get("userAttributes", {})
    user_id = attrs.get("sub")
    email = attrs.get("email")
    full_name = attrs.get("name")

    if not user_id:
        raise ValueError("Missing user sub")
    if not email:
        raise ValueError("Missing user email")

    now = datetime.now(timezone.utc).isoformat()
    table = dynamodb.Table(os.environ["USERS_TABLE_NAME"])

    try:
        table.put_item(
            Item={
                "userId": user_id,
                "email": email,
                "fullName": full_name,
                "role": "user",
                "status": "active",
                "createdAt": now,
                "updatedAt": now,
            },
            ConditionExpression="attribute_not_exists(userId)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # User already exists — safe to ignore on re-confirmation
            pass
        else:
            raise

    return event
