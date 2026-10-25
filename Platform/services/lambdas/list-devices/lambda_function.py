import json
import os
import re
import boto3
import device_fields
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

# What the lists read from each DEVICE#/METADATA. "name" and "type" are
# DynamoDB reserved words.
LIST_PROJECTION = ", ".join(
    ["pk", "#name", "#type", "reverseEngineeringStatus", "workspaceId", *device_fields.OPTIONAL_FIELDS]
)


def handler(event, context):
    """GET /devices: the caller's personal devices.
    GET /devices?workspaceId=...: the devices of a workspace the caller belongs to.
    GET /devices/{deviceId}: one device, with all of its details.
    """
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    table = dynamodb.Table(TABLE)

    if event.get("resource") == "/devices/{deviceId}":
        return _get_device(table, user_id, (event.get("pathParameters") or {}).get("deviceId"))

    params = event.get("queryStringParameters") or {}
    if "workspaceId" in params:
        return _list_workspace_devices(table, user_id, params["workspaceId"])

    links = _query_all(
        table,
        Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with(DEVICE_SK_PREFIX),
    )

    # The link rows only find the devices; everything shown is read from
    # DEVICE#/METADATA, in one BatchGetItem per 100 devices rather than a
    # GetItem per device. The link's copy of the name is only a fallback for
    # a device whose METADATA is missing.
    device_ids = [item["sk"][len(DEVICE_SK_PREFIX):] for item in links]
    metadata = _batch_get_metadata(device_ids, LIST_PROJECTION)

    # A device whose METADATA has a workspaceId belongs to that workspace,
    # whatever USER#/DEVICE# rows remain, so it is never listed as personal.
    devices = [
        {
            **_list_fields(device_id, metadata.get(device_id), link.get("name")),
            "role": link.get("role"),
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
    metadata = _batch_get_metadata(device_ids, LIST_PROJECTION)

    # The WORKSPACE#/DEVICE# rows only find candidates: a device is listed
    # only if its METADATA says it belongs to this workspace. "role" is the
    # caller's role in the workspace, in place of the personal list's
    # ownership role.
    devices = [
        {
            **_list_fields(device_id, metadata[device_id]),
            "role": role,
            "workspaceId": workspace_id,
        }
        for device_id in device_ids
        if (metadata.get(device_id) or {}).get("workspaceId") == workspace_id
    ]

    return _resp(200, {"devices": devices, "workspaceId": workspace_id})


def _get_device(table, user_id, raw_id):
    if not isinstance(raw_id, str) or not UUID_PATTERN.match(raw_id):
        return _resp(400, {"error": "deviceId is invalid or missing"})
    device_id = raw_id

    # The read rule of GET /devices: any USER#/DEVICE# link for a personal
    # device, membership of its workspace for a workspace device (a leftover
    # link is never consulted for it). Same status codes as PATCH.
    try:
        item = testbed_authz.require_resource(table, user_id, "DEVICE", device_id,
                                              legacy_roles=testbed_authz.ANY_ROLE)
    except testbed_authz.NotFound:
        return _resp(404, {"error": "Device not found"})
    except testbed_authz.Forbidden:
        return _resp(403, {"error": "Not authorized for this device"})

    if "workspaceId" in item:
        role = testbed_authz.workspace_role(table, user_id, item["workspaceId"])
    else:
        link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item")
        role = (link or {}).get("role")
    if role is None:
        # Access was removed between the two reads.
        return _resp(403, {"error": "Not authorized for this device"})

    device = {
        **_list_fields(device_id, item),
        "role": role,
        "status": item.get("status"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }
    for field in ("workspaceId", "createdBy"):
        if field in item:
            device[field] = item[field]
    return _resp(200, device)


def _list_fields(device_id, item, fallback_name=None):
    """The fields every device response has. Optional details are included
    only when the device has them."""
    item = item or {}
    fields = {
        "deviceId": device_id,
        "name": item.get("name", fallback_name),
        "type": item.get("type"),
        "reverseEngineeringStatus": _re_status(item),
    }
    fields.update(device_fields.optional_values(item))
    return fields


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
        names = {alias: attr for alias, attr in (("#name", "name"), ("#type", "type")) if alias in projection}
        if names:
            request[TABLE]["ExpressionAttributeNames"] = names
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
