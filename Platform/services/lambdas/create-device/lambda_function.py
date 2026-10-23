import json
import os
import re
import uuid
import boto3
import testbed_authz
from datetime import datetime, timezone
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

client = boto3.client("dynamodb")
dynamodb = boto3.resource("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]

REQUIRED_FIELDS = ["name", "type"]

# Separate from the device's lifecycle "status"; changed with
# PATCH /devices/{deviceId} (update-device).
DEFAULT_RE_STATUS = "not_started"

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def handler(event, context):
    """POST /devices with {name, type, workspaceId?}.

    Without workspaceId the device is personal: the caller owns it through
    USER#/DEVICE# links. With one, the device belongs to that workspace
    (any member may create it): its METADATA carries the workspaceId, which
    is what authorizes access, and it has WORKSPACE#/DEVICE# links instead
    of ownership links.
    """
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

    if "workspaceId" in body:
        workspace_id = body["workspaceId"]
        if not isinstance(workspace_id, str) or not UUID_PATTERN.match(workspace_id):
            return _resp(400, {"error": "workspaceId is invalid"})
        return _create_workspace_device(user_id, workspace_id, values)

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
        "reverseEngineeringStatus": DEFAULT_RE_STATUS,
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
            _log_cancellation(device_id, e, reasons)
            return _resp(500, {"error": "Failed to create device"})
        raise

    return _resp(
        201,
        {
            "deviceId": device_id,
            "name": values["name"],
            "type": values["type"],
            "status": "active",
            "reverseEngineeringStatus": DEFAULT_RE_STATUS,
            "dataPath": data_path,
            "createdAt": now,
            "updatedAt": now,
        },
    )


def _create_workspace_device(user_id, workspace_id, values):
    table = dynamodb.Table(TABLE)

    # Members and owners may add devices. A non-member gets the same 404 as
    # a workspace that doesn't exist, so a forged id reveals nothing.
    try:
        testbed_authz.require_member(table, user_id, workspace_id)
    except testbed_authz.AuthorizationError:
        return _resp(404, {"error": "Workspace not found"})
    if table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item") is None:
        return _resp(404, {"error": "Workspace not found"})

    device_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    data_path = f"s3://{BUCKET}/devices/{device_id}/"

    device_item = {
        "pk": f"DEVICE#{device_id}",
        "sk": "METADATA",
        "entity": "device",
        "deviceId": device_id,
        "name": values["name"],
        "type": values["type"],
        "status": "active",
        "reverseEngineeringStatus": DEFAULT_RE_STATUS,
        "dataPath": data_path,
        # Authoritative: testbed_authz authorizes this device by membership
        # of this workspace, never by USER#/DEVICE# links.
        "workspaceId": workspace_id,
        "createdBy": user_id,
        "createdAt": now,
        "updatedAt": now,
    }

    # Listing rows only; neither grants access on its own. No USER#/DEVICE#
    # ownership rows are written for a workspace device.
    workspace_device_item = {
        "pk": f"WORKSPACE#{workspace_id}",
        "sk": f"DEVICE#{device_id}",
        "entity": "workspace-device",
        "name": values["name"],
        "createdBy": user_id,
        "createdAt": now,
    }

    device_workspace_item = {
        "pk": f"DEVICE#{device_id}",
        "sk": f"WORKSPACE#{workspace_id}",
        "entity": "device-workspace",
        "createdAt": now,
    }

    # The workspace and the caller's membership are re-checked inside the
    # transaction, so a membership removed after the check above can't
    # still add a device.
    try:
        client.transact_write_items(
            TransactItems=[
                _put(device_item),
                _put(workspace_device_item),
                _put(device_workspace_item),
                _condition_check(f"WORKSPACE#{workspace_id}", "METADATA", "attribute_exists(pk)"),
                _membership_check(user_id, workspace_id),
            ]
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            reasons = e.response.get("CancellationReasons", [])
            failed = [i for i, r in enumerate(reasons) if r.get("Code") == "ConditionalCheckFailed"]
            if any(i >= 3 for i in failed):
                return _resp(404, {"error": "Workspace not found"})
            if failed:
                return _resp(409, {"error": "Device already exists"})
            _log_cancellation(device_id, e, reasons)
            return _resp(500, {"error": "Failed to create device"})
        raise

    return _resp(
        201,
        {
            "deviceId": device_id,
            "name": values["name"],
            "type": values["type"],
            "status": "active",
            "reverseEngineeringStatus": DEFAULT_RE_STATUS,
            "dataPath": data_path,
            "workspaceId": workspace_id,
            "createdBy": user_id,
            "createdAt": now,
            "updatedAt": now,
        },
    )


def _log_cancellation(device_id, error, reasons):
    print(json.dumps({
        "event": "create_device_transaction_canceled",
        "deviceId": device_id,
        "message": error.response["Error"].get("Message"),
        "cancellationReasons": [
            {"code": r.get("Code"), "message": r.get("Message")}
            for r in reasons
        ],
    }))


def _put(item):
    return {
        "Put": {
            "TableName": TABLE,
            "Item": {k: serializer.serialize(v) for k, v in item.items()},
            "ConditionExpression": "attribute_not_exists(pk)",
        }
    }


def _condition_check(pk, sk, condition, names=None, values=None):
    check = {
        "TableName": TABLE,
        "Key": {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)},
        "ConditionExpression": condition,
    }
    if names:
        check["ExpressionAttributeNames"] = names
    if values:
        check["ExpressionAttributeValues"] = {k: serializer.serialize(v) for k, v in values.items()}
    return {"ConditionCheck": check}


def _membership_check(user_id, workspace_id):
    roles = {f":role{i}": role for i, role in enumerate(testbed_authz.WORKSPACE_ROLES)}
    return _condition_check(
        f"USER#{user_id}", f"WORKSPACE#{workspace_id}", f"#role IN ({', '.join(roles)})",
        names={"#role": "role"}, values=roles,
    )


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
