import json
import os
import re
import time
import boto3
import device_fields
import testbed_authz
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]

# reverseEngineeringStatus is separate from the device's lifecycle "status"
# (always "active"), which this endpoint never touches.
RE_STATUSES = ("not_started", "in_progress", "complete")
# Devices created before reverseEngineeringStatus existed have no attribute.
DEFAULT_RE_STATUS = "not_started"
EDITABLE_FIELDS = {*device_fields.REQUIRED_FIELDS, *device_fields.OPTIONAL_FIELDS}
UPDATABLE_FIELDS = EDITABLE_FIELDS | {"reverseEngineeringStatus"}
# Set by the server only: keys, scope, provenance and bookkeeping. Named in
# their own error so a client learns they can't be changed, not that they
# don't exist.
PROTECTED_FIELDS = {"pk", "sk", "entity", "deviceId", "workspaceId", "createdBy", "createdAt", "updatedAt",
                    "status", "dataPath", "role", "pendingNameSync"}

# The rows that repeat the device's name, found from the DEVICE# partition:
# sk prefix there -> (key of the copy, attribute holding the name).
NAME_COPIES = {
    "USER#": lambda sk, did: ({"pk": sk, "sk": f"DEVICE#{did}"}, "name"),
    "WORKSPACE#": lambda sk, did: ({"pk": sk, "sk": f"DEVICE#{did}"}, "name"),
    # DEVICE#/ARTIFACT#{type}#{artifactId} -> ARTIFACT#{artifactId}/DEVICE#
    "ARTIFACT#": lambda sk, did: ({"pk": f"ARTIFACT#{sk.rsplit('#', 1)[-1]}", "sk": f"DEVICE#{did}"}, "name"),
    "CVE#": lambda sk, did: ({"pk": sk, "sk": f"DEVICE#{did}"}, "deviceName"),
}
# One ConditionCheck on METADATA plus up to 99 copies per transaction.
SYNC_CHUNK = 99
SYNC_ATTEMPTS = 4

# create-device generates deviceId via str(uuid.uuid4()) — this is the
# canonical lowercase, hyphenated form that produces. Matching it exactly
# makes that API contract explicit rather than accepting any string.
DEVICE_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


class SyncSuperseded(Exception):
    """The device was renamed again while its copies were being updated; the
    later rename updates them instead."""


def handler(event, context):
    """PATCH /devices/{deviceId} with any of: reverseEngineeringStatus, name,
    type and the optional fields in device_fields.OPTIONAL_FIELDS.

    Only the fields sent are changed. An optional field sent as null or an
    empty string is removed; name and type can be changed but not removed.
    """
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

    # A personal device (no workspaceId on its METADATA) keeps the rule of the
    # other device mutation endpoints (presign-firmware, complete-firmware,
    # artifacts-presign): only an owner may change it. A workspace device may
    # be changed by any member of its workspace, and only by members: a
    # leftover USER#/DEVICE# owner row is never consulted for it.
    try:
        testbed_authz.require_resource(table, user_id, "DEVICE", device_id, legacy_roles=("owner",))
    except testbed_authz.NotFound:
        return _resp(404, {"error": "Device not found"})
    except testbed_authz.Forbidden:
        return _resp(403, {"error": "Not authorized for this device"})

    protected = sorted(set(body) & PROTECTED_FIELDS)
    if protected:
        return _resp(400, {"error": f"Field(s) cannot be changed: {', '.join(protected)}"})
    unsupported = sorted(set(body) - UPDATABLE_FIELDS)
    if unsupported:
        return _resp(400, {"error": f"Unsupported field(s): {', '.join(unsupported)}"})
    if not body:
        return _resp(400, {"error": "No fields to update"})

    sets, removes = {}, []
    if "reverseEngineeringStatus" in body:
        status = body["reverseEngineeringStatus"]
        if status not in RE_STATUSES:
            return _resp(400, {
                "error": f"reverseEngineeringStatus must be one of: {', '.join(RE_STATUSES)}"
            })
        sets["reverseEngineeringStatus"] = status
    try:
        for field in sorted(set(body) & EDITABLE_FIELDS):
            if field in device_fields.REQUIRED_FIELDS:
                sets[field] = device_fields.clean_required(field, body[field])
            else:
                value = device_fields.clean_optional(field, body[field])
                if value is None:
                    removes.append(field)
                else:
                    sets[field] = value
    except device_fields.FieldError as e:
        return _resp(400, {"error": str(e)})

    now = datetime.now(timezone.utc).isoformat()
    sets["updatedAt"] = now
    if "name" in sets:
        # Marks the copies of the name as out of date until they have all
        # been rewritten, so a sync cut short is finished by the next update.
        sets["pendingNameSync"] = sets["name"]

    names, values = {}, {}
    assignments = []
    for i, (field, value) in enumerate(sets.items()):
        names[f"#s{i}"] = field
        values[f":s{i}"] = value
        assignments.append(f"#s{i} = :s{i}")
    expression = "SET " + ", ".join(assignments)
    if removes:
        for i, field in enumerate(removes):
            names[f"#r{i}"] = field
        expression += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(removes)))

    # Only the canonical DEVICE#/METADATA record holds these fields; the link
    # rows carry only the name, updated below. The condition stops an update
    # from creating a bare item if the metadata record is missing.
    try:
        updated = table.update_item(
            Key={"pk": f"DEVICE#{device_id}", "sk": "METADATA"},
            UpdateExpression=expression,
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"error": "Device not found"})
        raise

    if "pendingNameSync" in updated:
        try:
            _sync_name(table, device_id, updated["pendingNameSync"])
        except SyncSuperseded:
            # Another request renamed the device after this one; it owns the
            # copies now. Report what the device is now.
            current = table.get_item(Key={"pk": f"DEVICE#{device_id}", "sk": "METADATA"}).get("Item")
            updated = current or updated
        except Exception as e:
            # METADATA has the new name and keeps pendingNameSync, so the
            # next update of this device finishes the sync.
            print(json.dumps({"event": "device_name_sync_failed", "deviceId": device_id, "error": repr(e)}))
            return _resp(500, {
                "error": "The device was saved, but not every record showing its name was updated. "
                         "Save again to finish."
            })

    return _resp(200, _public_device(device_id, updated))


def _sync_name(table, device_id, name):
    """Writes the device's name to every row that repeats it.

    Each transaction also checks that METADATA still has this name, so a sync
    for an older name can never overwrite a newer one. The endpoints that copy
    an existing device's name into a new row (artifacts-presign, cves-api)
    check METADATA's name in their own transaction, so a row they add during a
    rename has either been found by the queries below or carries the new name.
    """
    targets = {}
    for prefix, copy_of in NAME_COPIES.items():
        for row in _query_all(table, f"DEVICE#{device_id}", prefix):
            key, attr = copy_of(row["sk"], device_id)
            # A transaction may not touch one row twice.
            targets[(key["pk"], key["sk"])] = (key, attr)
    targets = list(targets.values())

    for start in range(0, len(targets), SYNC_CHUNK):
        _write_name_chunk(device_id, name, targets[start:start + SYNC_CHUNK])

    # Done, unless a later rename has already taken over.
    try:
        table.update_item(
            Key={"pk": f"DEVICE#{device_id}", "sk": "METADATA"},
            UpdateExpression="REMOVE pendingNameSync",
            ConditionExpression="pendingNameSync = :name",
            ExpressionAttributeValues={":name": name},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _write_name_chunk(device_id, name, targets):
    metadata_check = {"ConditionCheck": {
        "TableName": TABLE,
        "Key": _key(f"DEVICE#{device_id}", "METADATA"),
        "ConditionExpression": "#name = :name",
        "ExpressionAttributeNames": {"#name": "name"},
        "ExpressionAttributeValues": {":name": serializer.serialize(name)},
    }}
    for attempt in range(SYNC_ATTEMPTS):
        if not targets:
            return
        items = [metadata_check] + [
            {"Update": {
                "TableName": TABLE,
                "Key": _key(key["pk"], key["sk"]),
                "UpdateExpression": "SET #attr = :name",
                # Never creates a row whose other half is missing.
                "ConditionExpression": "attribute_exists(pk)",
                "ExpressionAttributeNames": {"#attr": attr},
                "ExpressionAttributeValues": {":name": serializer.serialize(name)},
            }}
            for key, attr in targets
        ]
        try:
            client.transact_write_items(TransactItems=items)
            return
        except ClientError as e:
            if e.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = e.response.get("CancellationReasons", [])
            if reasons and reasons[0].get("Code") == "ConditionalCheckFailed":
                raise SyncSuperseded()
            # A copy whose row is gone has nothing to update; retry without it.
            missing = {i - 1 for i, r in enumerate(reasons) if i and r.get("Code") == "ConditionalCheckFailed"}
            targets = [t for i, t in enumerate(targets) if i not in missing]
            if not missing:
                # A conflicting write on one of the rows: back off and retry.
                time.sleep(0.1 * (attempt + 1))
    raise RuntimeError("name sync did not complete after retries")


def _query_all(table, pk, prefix):
    # Strongly consistent, so a link committed just before the rename is seen.
    items, kwargs = [], {
        "KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
        "ConsistentRead": True,
    }
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _public_device(device_id, item):
    device = {
        "deviceId": device_id,
        "name": item.get("name"),
        "type": item.get("type"),
        "reverseEngineeringStatus": item.get("reverseEngineeringStatus")
        if item.get("reverseEngineeringStatus") in RE_STATUSES else DEFAULT_RE_STATUS,
        "updatedAt": item.get("updatedAt"),
        **device_fields.optional_values(item),
    }
    if "workspaceId" in item:
        device["workspaceId"] = item["workspaceId"]
    return device


def _key(pk, sk):
    return {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)}


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
