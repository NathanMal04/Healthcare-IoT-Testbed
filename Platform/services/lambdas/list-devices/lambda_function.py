import json
import os
import re
import boto3
import testbed_authz
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

DEVICE_SK_PREFIX = "DEVICE#"

RE_STATUSES = {"not_started", "in_progress", "complete"}
# Devices created before reverseEngineeringStatus existed have no attribute;
# they read as not started, so no migration is needed.
DEFAULT_RE_STATUS = "not_started"

BATCH_GET_MAX_KEYS = 100

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def handler(event, context):
    """GET /devices: the caller's personal devices.
    GET /devices?workspaceId=...: the devices of a workspace the caller belongs to.
    """
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    table = dynamodb.Table(TABLE)

    params = event.get("queryStringParameters") or {}
    if "workspaceId" in params:
        return _list_workspace_devices(table, user_id, params["workspaceId"])

    links = _query_all(
        table,
        Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with(DEVICE_SK_PREFIX),
    )

    # The link rows only carry immutable display fields; anything that
    # changes lives on DEVICE#/METADATA, read here in one BatchGetItem per
    # 100 devices rather than a GetItem per device.
    device_ids = [item["sk"][len(DEVICE_SK_PREFIX):] for item in links]
    metadata = _batch_get_metadata(device_ids, "pk, reverseEngineeringStatus, workspaceId")

    # A device whose METADATA has a workspaceId belongs to that workspace,
    # whatever USER#/DEVICE# rows remain, so it is never listed as personal.
    devices = [
        {
            "deviceId": device_id,
            "name": link.get("name"),
            "role": link.get("role"),
            "reverseEngineeringStatus": _re_status(metadata.get(device_id)),
        }
        for device_id, link in zip(device_ids, links)
        if "workspaceId" not in (metadata.get(device_id) or {})
    ]

    return _resp(200, {"devices": devices})


def _list_workspace_devices(table, user_id, workspace_id):
    if not isinstance(workspace_id, str) or not UUID_PATTERN.match(workspace_id):
        return _resp(400, {"error": "workspaceId is invalid"})

    # A non-member gets the same 404 as a workspace that doesn't exist.
    try:
        role = testbed_authz.require_member(table, user_id, workspace_id)
    except testbed_authz.AuthorizationError:
        return _resp(404, {"error": "Workspace not found"})
    if table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item") is None:
        return _resp(404, {"error": "Workspace not found"})

    links = _query_all(
        table,
        Key("pk").eq(f"WORKSPACE#{workspace_id}") & Key("sk").begins_with(DEVICE_SK_PREFIX),
    )
    device_ids = [item["sk"][len(DEVICE_SK_PREFIX):] for item in links]
    metadata = _batch_get_metadata(device_ids, "pk, #name, reverseEngineeringStatus, workspaceId")

    # The WORKSPACE#/DEVICE# rows only find candidates: a device is listed
    # only if its METADATA says it belongs to this workspace. "role" is the
    # caller's role in the workspace, in place of the personal list's
    # ownership role.
    devices = [
        {
            "deviceId": device_id,
            "name": metadata[device_id].get("name"),
            "role": role,
            "reverseEngineeringStatus": _re_status(metadata[device_id]),
            "workspaceId": workspace_id,
        }
        for device_id in device_ids
        if (metadata.get(device_id) or {}).get("workspaceId") == workspace_id
    ]

    return _resp(200, {"devices": devices, "workspaceId": workspace_id})


def _query_all(table, key_condition):
    items, kwargs = [], {"KeyConditionExpression": key_condition}
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _batch_get_metadata(device_ids, projection):
    """Returns {deviceId: metadata item} for the devices that have one."""
    found = {}
    unique_ids = list(dict.fromkeys(device_ids))
    for start in range(0, len(unique_ids), BATCH_GET_MAX_KEYS):
        keys = [
            {"pk": f"DEVICE#{device_id}", "sk": "METADATA"}
            for device_id in unique_ids[start:start + BATCH_GET_MAX_KEYS]
        ]
        request = {TABLE: {"Keys": keys, "ProjectionExpression": projection}}
        if "#name" in projection:
            # "name" is a DynamoDB reserved word.
            request[TABLE]["ExpressionAttributeNames"] = {"#name": "name"}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            for item in result.get("Responses", {}).get(TABLE, []):
                found[item["pk"][len("DEVICE#"):]] = item
            request = result.get("UnprocessedKeys") or None
    return found


def _re_status(item):
    value = (item or {}).get("reverseEngineeringStatus")
    return value if value in RE_STATUSES else DEFAULT_RE_STATUS


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
