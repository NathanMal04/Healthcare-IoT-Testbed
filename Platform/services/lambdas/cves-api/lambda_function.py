"""CVEs: known/public vulnerabilities recorded against the devices under research.

  POST  /cves                   {cveId, severity, ...; workspaceId?}  record a CVE
  GET   /cves                   the caller's personal CVEs
  GET   /cves?workspaceId=...   the CVEs of a workspace the caller belongs to
  GET   /cves/{cveRecordId}     one CVE, with description and references
  PATCH /cves/{cveRecordId}     change its mutable fields
  DELETE /cves/{cveRecordId}    delete it, with its claim and every device link
  PUT    /cves/{cveRecordId}/devices/{deviceId}   link a device of the CVE's scope
  DELETE /cves/{cveRecordId}/devices/{deviceId}   unlink it

A CVE record has its own id (cveRecordId, a UUIDv7) separate from the public
identifier (cveId, "CVE-2021-37584"): the same public CVE can be recorded once
per scope, Personal or a workspace, so cveId alone doesn't name a record.

Scope works like devices: without a workspaceId the CVE is personal, owned
through USER#/CVE# links; with one, its METADATA carries the workspaceId,
which is what authorizes access (testbed_authz), and it has WORKSPACE#/CVE#
links instead of ownership links. A USER#{uid} / CVEID#{cveId} or
WORKSPACE#{wid} / CVEID#{cveId} claim row, written in the same transaction,
keeps cveId unique per scope.

A CVE links to devices of its own scope through DEVICE#{did} / CVE#{rid} and
CVE#{rid} / DEVICE#{did} rows, mirrored in the deviceIds String Set on its
METADATA (absent when no device is linked, never an empty set). Every link,
unlink and PATCH bumps the METADATA version, which DELETE is conditional on,
so a CVE can't be deleted while its links change underneath.
"""
import json
import os
import re
import secrets
import time
import uuid
import boto3
import testbed_authz
from datetime import datetime, timezone
from decimal import Decimal, DecimalException
from urllib.parse import urlsplit
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]

SEVERITIES = ("low", "medium", "high", "critical")
CVSS_VERSIONS = ("2.0", "3.0", "3.1", "4.0")
CVSS_MAX = Decimal("10.0")
DESCRIPTION_MAX_LENGTH = 4000
CHIPSETS_MAX = 20
CHIPSET_MAX_LENGTH = 64
REFERENCES_MAX = 20
REFERENCE_MAX_LENGTH = 2048
# Longer than any valid id; only bounds the work done on garbage input.
CVE_ID_MAX_INPUT_LENGTH = 64
FIRST_CVE_YEAR = 1999

MUTABLE_FIELDS = {"severity", "cvssScore", "cvssVersion", "description", "affectedChipsets", "references"}
CREATE_FIELDS = MUTABLE_FIELDS | {"cveId", "workspaceId"}
# Named in the error rather than reported as unsupported, so a client that
# tries to change them is told why.
IMMUTABLE_FIELDS = {"cveRecordId", "cveId", "workspaceId", "createdBy", "createdAt", "updatedAt", "version",
                    "deviceIds"}
# Optional fields a PATCH can clear with null (or an empty value).
CLEARABLE_FIELDS = MUTABLE_FIELDS - {"severity"}
# GET /cves includes the description, which the web app searches, but leaves
# out references; GET /cves/{id} has everything.
LIST_ATTRIBUTES = ("pk", "cveRecordId", "cveId", "severity", "cvssScore", "cvssVersion", "description",
                   "affectedChipsets", "deviceIds", "workspaceId", "createdBy", "createdAt", "updatedAt", "version")

# DELETE removes a CVE in one transaction: METADATA, its two scope rows, the
# claim, a membership check and two rows per device, at most 100 items. 40
# keeps it within the limit (5 + 2 * 40 = 85) with room to spare.
MAX_DEVICES_PER_CVE = 40
MAX_TRANSACTION_ITEMS = 100

BATCH_GET_MAX_KEYS = 100

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# ASCII digits only ([0-9], not \d, which also matches other scripts' digits).
# Sequence numbers have at least 4 digits (CVE ID syntax since 2014).
CVE_ID_PATTERN = re.compile(r"CVE-([0-9]{4})-([0-9]{4,19})")
# U+2010..U+2015 (hyphen, non-breaking hyphen, figure dash, en/em dash,
# horizontal bar) and U+2212 (minus): what a CVE id pasted from a document
# often contains instead of "-".
UNICODE_HYPHENS = {**{cp: "-" for cp in range(0x2010, 0x2016)}, 0x2212: "-"}


class RequestError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


def handler(event, context):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
    user_id = claims.get("sub")
    # API Gateway's Cognito authorizer always supplies the claims; refuse
    # rather than fail if a request ever arrives without them.
    if not isinstance(user_id, str) or not user_id:
        return _resp(401, {"error": "Unauthorized"})

    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    table = dynamodb.Table(TABLE)

    try:
        route = (method, resource)
        if route == ("POST", "/cves"):
            return _create_cve(table, user_id, _json_body(event))
        if route == ("GET", "/cves"):
            return _list_cves(table, user_id, event.get("queryStringParameters") or {})
        if resource not in ("/cves/{cveRecordId}", "/cves/{cveRecordId}/devices/{deviceId}"):
            return _resp(404, {"error": "Unknown route"})

        path = event.get("pathParameters") or {}
        record_id = _uuid(path.get("cveRecordId"), "cveRecordId")
        if resource == "/cves/{cveRecordId}/devices/{deviceId}":
            device_id = _uuid(path.get("deviceId"), "deviceId")
            if method == "PUT":
                return _link_device(table, user_id, record_id, device_id)
            if method == "DELETE":
                return _unlink_device(table, user_id, record_id, device_id)
            return _resp(404, {"error": "Unknown route"})

        if method == "GET":
            return _resp(200, {"cve": _public_cve(_authorized_cve(table, user_id, record_id))})
        if method == "PATCH":
            return _update_cve(table, user_id, record_id, _json_body(event))
        if method == "DELETE":
            return _delete_cve(table, user_id, record_id)
    except RequestError as e:
        return _resp(e.status, {"error": e.message, **e.extra})

    return _resp(404, {"error": "Unknown route"})


# --- POST /cves -------------------------------------------------------------------

def _create_cve(table, user_id, body):
    _reject_fields(body, CREATE_FIELDS, IMMUTABLE_FIELDS - {"cveId", "workspaceId"})
    cve_id = normalize_cve_id(body.get("cveId"))
    fields = _validate_mutable(body, creating=True)

    workspace_id = None
    if "workspaceId" in body:
        workspace_id = _uuid(body["workspaceId"], "workspaceId")
        # Members and owners may record CVEs. A non-member gets the same 404
        # as a workspace that doesn't exist, so a forged id reveals nothing.
        try:
            testbed_authz.require_member(table, user_id, workspace_id)
        except testbed_authz.AuthorizationError:
            raise RequestError(404, "Workspace not found")
        if table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item") is None:
            raise RequestError(404, "Workspace not found")

    record_id = _uuid7()
    now = _iso(_utcnow())
    cve = {
        "pk": f"CVE#{record_id}", "sk": "METADATA", "entity": "cve",
        "cveRecordId": record_id, "cveId": cve_id, **fields,
        "createdBy": user_id, "createdAt": now, "updatedAt": now, "version": 1,
    }

    if workspace_id:
        # Authoritative: testbed_authz authorizes this CVE by membership of
        # this workspace, never by USER#/CVE# links.
        cve["workspaceId"] = workspace_id
        scope_pk = f"WORKSPACE#{workspace_id}"
        # Listing rows only; neither grants access on its own. No USER#/CVE#
        # ownership rows are written for a workspace CVE.
        links = [
            {"pk": scope_pk, "sk": f"CVE#{record_id}", "entity": "workspace-cve",
             "cveId": cve_id, "createdBy": user_id, "createdAt": now},
            {"pk": f"CVE#{record_id}", "sk": scope_pk, "entity": "cve-workspace", "createdAt": now},
        ]
    else:
        scope_pk = f"USER#{user_id}"
        links = [
            {"pk": scope_pk, "sk": f"CVE#{record_id}", "entity": "user-cve", "role": "owner", "cveId": cve_id},
            {"pk": f"CVE#{record_id}", "sk": scope_pk, "entity": "cve-user", "role": "owner"},
        ]

    claim_key = {"pk": scope_pk, "sk": f"CVEID#{cve_id}"}
    claim = {**claim_key, "entity": "cve-claim", "cveId": cve_id, "cveRecordId": record_id, "createdAt": now}

    items = [_put(cve), *(_put(link) for link in links), _put(claim)]
    claim_index = len(items) - 1
    if workspace_id:
        # The workspace and the caller's membership are re-checked inside the
        # transaction, so a membership removed after the check above can't
        # still record a CVE.
        items += [
            _condition_check(f"WORKSPACE#{workspace_id}", "METADATA", "attribute_exists(pk)"),
            _membership_check(user_id, workspace_id),
        ]

    failed = _transact(items, "create_cve", record_id)
    if any(i > claim_index for i in failed):
        raise RequestError(404, "Workspace not found")
    if claim_index in failed:
        # The claim is in the caller's own scope (their USER# partition, or a
        # workspace they were just confirmed a member of), so the existing
        # record's id is theirs to see.
        existing = table.get_item(Key=claim_key).get("Item") or {}
        extra = {"cveId": cve_id}
        if isinstance(existing.get("cveRecordId"), str):
            extra["cveRecordId"] = existing["cveRecordId"]
        raise RequestError(409, f"{cve_id} is already recorded in this scope", extra)
    if failed:
        raise RequestError(409, "CVE record already exists")

    return _resp(201, {"cve": _public_cve(cve)})


# --- GET /cves --------------------------------------------------------------------

def _list_cves(table, user_id, params):
    if "workspaceId" in params:
        workspace_id = _uuid(params["workspaceId"], "workspaceId")
        # A non-member gets the same 404 as a workspace that doesn't exist.
        try:
            testbed_authz.require_member(table, user_id, workspace_id)
        except testbed_authz.AuthorizationError:
            raise RequestError(404, "Workspace not found")
        if table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item") is None:
            raise RequestError(404, "Workspace not found")
        links = [row for row in _query_all(table, f"WORKSPACE#{workspace_id}", "CVE#")
                 if row.get("entity") == "workspace-cve"]
    else:
        workspace_id = None
        links = [row for row in _query_all(table, f"USER#{user_id}", "CVE#")
                 if row.get("entity") == "user-cve" and row.get("role") == "owner"]

    # "CVE#" never matches the "CVEID#" claim rows, and the entity filter above
    # makes sure of it; only well-formed ids become METADATA keys.
    record_ids = [rid for rid in (row["sk"][len("CVE#"):] for row in links) if UUID_PATTERN.fullmatch(rid)]
    metadata = _batch_get_metadata(record_ids)

    # The link rows only find candidates: a CVE is listed only if its METADATA
    # puts it in this scope (no workspaceId for Personal, exactly this one for
    # a workspace), whatever USER# or WORKSPACE# rows remain.
    cves = [
        _public_cve(metadata[rid], full=False)
        for rid in record_ids
        if rid in metadata and metadata[rid].get("workspaceId") == workspace_id
    ]
    body = {"cves": cves}
    if workspace_id:
        body["workspaceId"] = workspace_id
    return _resp(200, body)


# --- PATCH /cves/{cveRecordId} ------------------------------------------------------

def _update_cve(table, user_id, record_id, body):
    current = _authorized_cve(table, user_id, record_id)

    _reject_fields(body, MUTABLE_FIELDS, IMMUTABLE_FIELDS)
    if not body:
        raise RequestError(400, "No fields to update")
    fields = _validate_mutable(body, creating=False)

    now = _iso(_utcnow())
    names = {"#version": "version", "#updatedAt": "updatedAt"}
    values = {":one": 1, ":now": now, ":expected": current["version"]}
    sets, removes = ["#updatedAt = :now", "#version = #version + :one"], []
    for i, field in enumerate(sorted(body)):
        names[f"#f{i}"] = field
        if field in fields:
            values[f":f{i}"] = fields[field]
            sets.append(f"#f{i} = :f{i}")
        else:
            removes.append(f"#f{i}")
    expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")

    # attribute_exists stops the update from recreating a record deleted
    # during the request; the version check makes a concurrent PATCH a 409
    # rather than a silent overwrite; the scope condition keeps the CVE in
    # the scope it was authorized in.
    condition = "attribute_exists(pk) AND #version = :expected"
    workspace_id = current.get("workspaceId")
    if workspace_id is not None:
        names["#workspaceId"] = "workspaceId"
        values[":workspaceId"] = workspace_id
        condition += " AND #workspaceId = :workspaceId"
        # Membership is re-checked inside the transaction, so one removed
        # after the authorization above can't still change the CVE.
        scope_check = _membership_check(user_id, workspace_id)
    else:
        names["#workspaceId"] = "workspaceId"
        condition += " AND attribute_not_exists(#workspaceId)"
        scope_check = _condition_check(f"USER#{user_id}", f"CVE#{record_id}", "#role = :owner",
                                       names={"#role": "role"}, values={":owner": "owner"})

    update = {"Update": {
        "TableName": TABLE,
        "Key": _key(f"CVE#{record_id}", "METADATA"),
        "UpdateExpression": expression,
        "ConditionExpression": condition,
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": _values(values),
    }}
    failed = _transact([update, scope_check], "update_cve", record_id)
    if 1 in failed:
        raise RequestError(404, "CVE not found")
    if 0 in failed:
        if table.get_item(Key={"pk": f"CVE#{record_id}", "sk": "METADATA"}).get("Item") is None:
            raise RequestError(404, "CVE not found")
        raise RequestError(409, "This CVE was changed by another request; reload it and try again")

    updated = {**current, **fields, "updatedAt": now, "version": current["version"] + 1}
    for field in body:
        if field not in fields:
            updated.pop(field, None)
    return _resp(200, {"cve": _public_cve(updated)})


# --- PUT /cves/{cveRecordId}/devices/{deviceId} ---------------------------------------

def _link_device(table, user_id, record_id, device_id):
    cve = _authorized_cve(table, user_id, record_id)
    workspace_id = cve.get("workspaceId")

    # The device endpoints' rule: the owner of a personal device, or any member
    # of a workspace device's workspace (never a leftover USER#/DEVICE# row).
    # 404 either way, so device ids aren't revealed.
    try:
        device = testbed_authz.require_resource(table, user_id, "DEVICE", device_id, legacy_roles=("owner",))
    except testbed_authz.AuthorizationError:
        raise RequestError(404, "Device not found")
    # The caller may use both, so naming the mismatch reveals nothing new.
    if device.get("workspaceId") != workspace_id:
        raise RequestError(400, "Device belongs to a different scope than the CVE")

    # Idempotent: linking a linked device changes nothing.
    if _link_exists(table, record_id, device_id):
        return _resp(200, {"cve": _public_cve(cve), "changed": False})

    now = _iso(_utcnow())
    names = {"#version": "version", "#updatedAt": "updatedAt", "#deviceIds": "deviceIds"}
    # ADD of a one-element set: deviceIds is created non-empty, never empty.
    values = {":one": 1, ":now": now, ":device": {device_id}, ":max": MAX_DEVICES_PER_CVE}
    # No version condition: adding to a set commutes, so concurrent links of
    # different devices both succeed. The version still moves, which is what
    # makes a concurrent DELETE fail rather than leave this link behind.
    condition = (f"attribute_exists(pk) AND {_scope_condition(workspace_id, names, values)}"
                 " AND (attribute_not_exists(#deviceIds) OR size(#deviceIds) < :max)")
    update = _update(record_id, "SET #updatedAt = :now, #version = #version + :one ADD #deviceIds :device",
                     condition, names, values)

    device_cve = {"pk": f"DEVICE#{device_id}", "sk": f"CVE#{record_id}", "entity": "device-cve",
                  "cveId": cve["cveId"], "createdBy": user_id, "createdAt": now}
    cve_device = {"pk": f"CVE#{record_id}", "sk": f"DEVICE#{device_id}", "entity": "cve-device",
                  "deviceName": device.get("name"), "createdBy": user_id, "createdAt": now}

    # The device must still be in the CVE's scope, and the caller still allowed,
    # when the links are written; either may change after the reads above.
    if workspace_id is not None:
        device_check = _condition_check(f"DEVICE#{device_id}", "METADATA", "#workspaceId = :workspaceId",
                                        names={"#workspaceId": "workspaceId"},
                                        values={":workspaceId": workspace_id})
    else:
        device_check = _condition_check(f"DEVICE#{device_id}", "METADATA",
                                        "attribute_exists(pk) AND attribute_not_exists(#workspaceId)",
                                        names={"#workspaceId": "workspaceId"})
    items = [update, _put(device_cve), _put(cve_device), device_check, _caller_check(user_id, record_id, workspace_id)]
    if workspace_id is None:
        items.append(_condition_check(f"USER#{user_id}", f"DEVICE#{device_id}", "#role = :owner",
                                      names={"#role": "role"}, values={":owner": "owner"}))

    failed = _transact(items, "link_device", record_id)
    if 3 in failed or 5 in failed:
        raise RequestError(404, "Device not found")
    if 4 in failed:
        raise RequestError(404, "CVE not found")
    if 0 in failed:
        current = _reload(table, record_id)
        if current is None or current.get("workspaceId") != workspace_id:
            raise RequestError(404, "CVE not found")
        if len(current.get("deviceIds") or ()) >= MAX_DEVICES_PER_CVE:
            raise RequestError(409, f"A CVE can be linked to at most {MAX_DEVICES_PER_CVE} devices")
        raise RequestError(409, "This CVE was changed by another request; reload it and try again")
    if failed:
        # A link row appeared after the check above: linked concurrently.
        if _link_exists(table, record_id, device_id):
            return _resp(200, {"cve": _public_cve(_reload(table, record_id) or cve), "changed": False})
        raise RequestError(409, "This CVE was changed by another request; reload it and try again")

    return _resp(200, {"cve": _public_cve(_reload_or_404(table, record_id)), "changed": True})


# --- DELETE /cves/{cveRecordId}/devices/{deviceId} ------------------------------------

def _unlink_device(table, user_id, record_id, device_id):
    cve = _authorized_cve(table, user_id, record_id)
    workspace_id = cve.get("workspaceId")

    # No device authorization: a link only ever joins a device of the CVE's
    # own scope, and unlinking must still work once a device is gone. The
    # device is never read, so nothing about it is revealed either.
    linked = set(cve.get("deviceIds") or ())
    row_exists = _link_exists(table, record_id, device_id)
    # Idempotent: unlinking a device that isn't linked changes nothing. A
    # device listed in deviceIds without its row (never expected) is still
    # removed, so unlink can always clean up.
    if not row_exists and device_id not in linked:
        return _resp(200, {"cve": _public_cve(cve), "changed": False})

    now = _iso(_utcnow())
    names = {"#version": "version", "#updatedAt": "updatedAt"}
    values = {":one": 1, ":now": now, ":expected": cve["version"]}
    # The version check pins deviceIds to what was read, so the branch chosen
    # below is the right one when the write happens; the size/contains
    # conditions state each branch's assumption explicitly as well.
    condition = f"attribute_exists(pk) AND #version = :expected AND {_scope_condition(workspace_id, names, values)}"
    expression = "SET #updatedAt = :now, #version = #version + :one"
    if linked == {device_id}:
        # The last device: REMOVE the attribute. An empty set is never stored.
        names["#deviceIds"] = "deviceIds"
        values[":deviceId"] = device_id
        expression += " REMOVE #deviceIds"
        condition += " AND size(#deviceIds) = :one AND contains(#deviceIds, :deviceId)"
    elif device_id in linked:
        names["#deviceIds"] = "deviceIds"
        values.update({":deviceId": device_id, ":device": {device_id}})
        expression += " DELETE #deviceIds :device"
        condition += " AND size(#deviceIds) > :one AND contains(#deviceIds, :deviceId)"
    # Otherwise the rows exist without their copy in deviceIds; removing the
    # rows is all that is needed, and deviceIds stays as it is.

    items = [
        _update(record_id, expression, condition, names, values),
        # Conditional on one side only: a concurrent unlink makes it fail, and
        # a missing mirror row (never expected) doesn't block the cleanup.
        _delete(f"CVE#{record_id}", f"DEVICE#{device_id}", "attribute_exists(pk)" if row_exists else None),
        _delete(f"DEVICE#{device_id}", f"CVE#{record_id}"),
        _caller_check(user_id, record_id, workspace_id),
    ]
    failed = _transact(items, "unlink_device", record_id)
    if 3 in failed:
        raise RequestError(404, "CVE not found")
    if 1 in failed and not _link_exists(table, record_id, device_id):
        # Unlinked concurrently.
        current = _reload(table, record_id)
        if current is None:
            raise RequestError(404, "CVE not found")
        return _resp(200, {"cve": _public_cve(current), "changed": False})
    if failed:
        if _reload(table, record_id) is None:
            raise RequestError(404, "CVE not found")
        raise RequestError(409, "This CVE was changed by another request; reload it and try again")

    return _resp(200, {"cve": _public_cve(_reload_or_404(table, record_id)), "changed": True})


# --- DELETE /cves/{cveRecordId} -----------------------------------------------------

def _delete_cve(table, user_id, record_id):
    # Any member may delete a workspace CVE, as they may change it; the owner
    # deletes a personal one.
    cve = _authorized_cve(table, user_id, record_id)
    workspace_id = cve.get("workspaceId")
    scope_pk = f"WORKSPACE#{workspace_id}" if workspace_id is not None else f"USER#{user_id}"

    # Every row in the CVE's partition other than METADATA is one side of a
    # two-way link ({kind}#{id}), whose other side is {kind}#{id} / CVE#{rid}.
    rows = _query_partition(table, f"CVE#{record_id}")
    link_sks = {row["sk"] for row in rows if row["sk"] != "METADATA"}
    # The record's own scope rows and every device in deviceIds are removed
    # even if a row of the pair is missing.
    link_sks.add(scope_pk)
    link_sks |= {f"DEVICE#{did}" for did in (cve.get("deviceIds") or ()) if UUID_PATTERN.fullmatch(did)}
    device_count = len([sk for sk in link_sks if sk.startswith("DEVICE#")])
    if device_count > MAX_DEVICES_PER_CVE:
        _log_refusal("delete_cve_too_many_devices", record_id, deviceCount=device_count)
        raise RequestError(409, f"This CVE has more than {MAX_DEVICES_PER_CVE} linked devices; unlink some first")

    names = {"#version": "version"}
    values = {":expected": cve["version"]}
    # The version check makes any link, unlink or PATCH since the reads above
    # cancel the delete, so no link row it didn't see can be left behind.
    condition = f"attribute_exists(pk) AND #version = :expected AND {_scope_condition(workspace_id, names, values)}"
    items = [_delete(f"CVE#{record_id}", "METADATA", condition, names, values)]
    for sk in sorted(link_sks):
        items.append(_delete(f"CVE#{record_id}", sk))
        kind, _, ident = sk.partition("#")
        if not ident or "#" in ident:
            continue  # never build a key from a malformed row
        if sk == f"USER#{user_id}" and workspace_id is None:
            # The caller's ownership link: deleting it re-checks ownership.
            items.append(_delete(sk, f"CVE#{record_id}", "#role = :owner",
                                 {"#role": "role"}, {":owner": "owner"}))
        else:
            items.append(_delete(sk, f"CVE#{record_id}"))
    owner_index = next((i for i, item in enumerate(items)
                        if workspace_id is None and _item_key(item) == (f"USER#{user_id}", f"CVE#{record_id}")), None)

    # The claim is deleted only if it is this record's: one that names another
    # record (never expected) or is already gone is left alone.
    claim_key = {"pk": scope_pk, "sk": f"CVEID#{cve['cveId']}"}
    claim = table.get_item(Key=claim_key, ConsistentRead=True).get("Item")
    if claim is not None and claim.get("cveRecordId") == record_id:
        items.append(_delete(claim_key["pk"], claim_key["sk"], "#cveRecordId = :rid",
                             {"#cveRecordId": "cveRecordId"}, {":rid": record_id}))
    elif claim is not None:
        _log_refusal("delete_cve_claim_not_ours", record_id, claimRecordId=claim.get("cveRecordId"))

    member_index = None
    if workspace_id is not None:
        member_index = len(items)
        items.append(_membership_check(user_id, workspace_id))

    if len(items) > MAX_TRANSACTION_ITEMS:
        _log_refusal("delete_cve_too_many_rows", record_id, items=len(items))
        raise RequestError(409, "This CVE has too many linked rows to delete in one step")

    failed = _transact(items, "delete_cve", record_id)
    if failed & {owner_index, member_index}:
        raise RequestError(404, "CVE not found")
    if 0 in failed and _reload(table, record_id) is None:
        raise RequestError(404, "CVE not found")
    if failed:
        raise RequestError(409, "This CVE was changed by another request; reload it and try again")

    return _resp(200, {"deleted": {"cveRecordId": record_id, "cveId": cve["cveId"], "deviceCount": device_count}})


# --- Validation -------------------------------------------------------------------

def normalize_cve_id(value):
    """Returns the canonical "CVE-YYYY-NNNN..." form, or raises a 400.

    Surrounding whitespace is dropped, Unicode hyphens become "-" and letters
    are uppercased before validating, so case and hyphen variants of one id
    always map to the same claim row.
    """
    if not isinstance(value, str) or not value.strip():
        raise RequestError(400, "cveId is required")
    if len(value) > CVE_ID_MAX_INPUT_LENGTH:
        raise RequestError(400, "cveId is invalid (expected CVE-YYYY-NNNN)")
    cve_id = value.strip().translate(UNICODE_HYPHENS).upper()
    match = CVE_ID_PATTERN.fullmatch(cve_id)
    if not match:
        raise RequestError(400, "cveId is invalid (expected CVE-YYYY-NNNN)")
    year = int(match.group(1))
    if not FIRST_CVE_YEAR <= year <= _utcnow().year + 1:
        raise RequestError(400, f"cveId year must be between {FIRST_CVE_YEAR} and {_utcnow().year + 1}")
    return cve_id


def _validate_mutable(body, creating):
    """Validated values of the mutable fields present in the body.

    On create, severity is required and empty optional fields are left out.
    On update, an optional field sent as null or empty is left out of the
    result, which tells the caller to remove it.
    """
    fields = {}
    if creating or "severity" in body:
        severity = body.get("severity")
        if severity not in SEVERITIES:
            raise RequestError(400, f"severity must be one of: {', '.join(SEVERITIES)}")
        fields["severity"] = severity

    validators = {
        "cvssScore": _cvss_score,
        "cvssVersion": _cvss_version,
        "description": _description,
        "affectedChipsets": _chipsets,
        "references": _references,
    }
    for field, validate in validators.items():
        if field not in body or body[field] is None:
            continue
        value = validate(body[field])
        if value not in ("", []):
            fields[field] = value
    return fields


def _cvss_score(value):
    # bool is a subclass of int, so True would otherwise pass as 1.
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise RequestError(400, "cvssScore must be a number from 0.0 to 10.0")
    score = Decimal(value)
    if not score.is_finite() or not Decimal(0) <= score <= CVSS_MAX:
        raise RequestError(400, "cvssScore must be a number from 0.0 to 10.0")
    # DynamoDB numbers hold 38 significant digits; refuse what it can't store
    # exactly (e.g. 1e-200) rather than round it or fail the write with a 500.
    try:
        serializer.serialize(score)
    except DecimalException:
        raise RequestError(400, "cvssScore has more precision than can be stored")
    # -0 is stored as 0; return it the same way.
    return abs(score) if score.is_zero() else score


def _cvss_version(value):
    if value not in CVSS_VERSIONS:
        raise RequestError(400, f"cvssVersion must be one of: {', '.join(CVSS_VERSIONS)}")
    return value


def _description(value):
    if not isinstance(value, str):
        raise RequestError(400, "description must be a string")
    text = value.strip()
    if len(text) > DESCRIPTION_MAX_LENGTH:
        raise RequestError(400, f"description is too long (max {DESCRIPTION_MAX_LENGTH} characters)")
    if any(_is_control(c) and c not in "\n\r\t" for c in text):
        raise RequestError(400, "description contains control characters")
    return text


def _chipsets(value):
    if not isinstance(value, list):
        raise RequestError(400, "affectedChipsets must be a list of strings")
    if len(value) > CHIPSETS_MAX:
        raise RequestError(400, f"affectedChipsets has too many entries (max {CHIPSETS_MAX})")
    chipsets, seen = [], set()
    for raw in value:
        if not isinstance(raw, str) or not raw.strip():
            raise RequestError(400, "affectedChipsets entries must be non-empty strings")
        name = raw.strip()
        if len(name) > CHIPSET_MAX_LENGTH or any(_is_control(c) for c in name):
            raise RequestError(
                400, f"affectedChipsets entries must be at most {CHIPSET_MAX_LENGTH} characters, "
                     "with no control characters")
        # "MT7610UN" and "mt7610un" are one chipset; the first spelling is kept.
        if name.casefold() not in seen:
            seen.add(name.casefold())
            chipsets.append(name)
    return chipsets


def _references(value):
    if not isinstance(value, list):
        raise RequestError(400, "references must be a list of URLs")
    if len(value) > REFERENCES_MAX:
        raise RequestError(400, f"references has too many entries (max {REFERENCES_MAX})")
    references = []
    for raw in value:
        url = raw.strip() if isinstance(raw, str) else None
        if not url or not _is_web_url(url):
            raise RequestError(400, "references must be http:// or https:// URLs")
        if url not in references:
            references.append(url)
    return references


def _is_web_url(url):
    # Only http(s), so a stored reference can never become a javascript: or
    # data: link in the browser.
    if len(url) > REFERENCE_MAX_LENGTH or any(c.isspace() or _is_control(c) for c in url):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme.lower() in ("http", "https") and bool(parts.netloc)


def _is_control(c):
    return ord(c) < 0x20 or 0x7f <= ord(c) < 0xa0


def _reject_fields(body, allowed, immutable):
    fixed = sorted((set(body) - allowed) & immutable)
    if fixed:
        raise RequestError(400, f"Field(s) cannot be set or changed: {', '.join(fixed)}")
    unsupported = sorted(set(body) - allowed)
    if unsupported:
        raise RequestError(400, f"Unsupported field(s): {', '.join(unsupported)}")


def _json_body(event):
    try:
        # Decimal, not float: the score is stored exactly. NaN/Infinity
        # literals are refused outright.
        body = json.loads(event.get("body") or "{}", parse_float=Decimal, parse_constant=_reject_constant)
    except (json.JSONDecodeError, ValueError):
        raise RequestError(400, "Invalid JSON in request body")
    if not isinstance(body, dict):
        raise RequestError(400, "Invalid JSON in request body")
    return body


def _reject_constant(name):
    raise ValueError(f"{name} is not allowed")


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        raise RequestError(400, f"{name} is invalid")
    return value


# --- Authorization and reads --------------------------------------------------------

def _authorized_cve(table, user_id, record_id):
    """The CVE's METADATA if the caller may use it: the owner of a personal
    CVE, or any member of a workspace CVE's workspace (never a leftover
    USER#/CVE# row). 404 either way otherwise, so ids aren't revealed."""
    try:
        return testbed_authz.require_resource(table, user_id, "CVE", record_id, legacy_roles=("owner",))
    except testbed_authz.AuthorizationError:
        raise RequestError(404, "CVE not found")


def _public_cve(item, full=True):
    view = {
        "cveRecordId": item.get("cveRecordId"),
        "cveId": item.get("cveId"),
        "severity": item.get("severity"),
        "cvssScore": float(item["cvssScore"]) if "cvssScore" in item else None,
        "cvssVersion": item.get("cvssVersion"),
        "affectedChipsets": list(item.get("affectedChipsets") or []),
        # A String Set, absent when no device is linked: always a sorted list here.
        "deviceIds": sorted(item.get("deviceIds") or ()),
        "createdBy": item.get("createdBy"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "version": int(item["version"]) if "version" in item else None,
    }
    view["description"] = item.get("description")
    if full:
        view["references"] = list(item.get("references") or [])
    if item.get("workspaceId"):
        # Only on workspace CVEs, as for devices and artifacts.
        view["workspaceId"] = item["workspaceId"]
    return view


def _query_all(table, pk, prefix):
    # Newest first: record ids are UUIDv7, so the link rows sort by creation.
    items, kwargs = [], {
        "KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
        "ScanIndexForward": False,
    }
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _query_partition(table, pk):
    # Every row of the partition, read consistently: DELETE must see every link.
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk), "ConsistentRead": True}
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _link_exists(table, record_id, device_id):
    key = {"pk": f"CVE#{record_id}", "sk": f"DEVICE#{device_id}"}
    return table.get_item(Key=key, ConsistentRead=True).get("Item") is not None


def _reload(table, record_id):
    return table.get_item(Key={"pk": f"CVE#{record_id}", "sk": "METADATA"}, ConsistentRead=True).get("Item")


def _reload_or_404(table, record_id):
    item = _reload(table, record_id)
    if item is None:
        raise RequestError(404, "CVE not found")
    return item


def _batch_get_metadata(record_ids):
    """Returns {cveRecordId: list fields of the METADATA} for the CVEs that have one."""
    names = {f"#a{i}": attr for i, attr in enumerate(LIST_ATTRIBUTES)}
    found = {}
    unique_ids = list(dict.fromkeys(record_ids))
    for start in range(0, len(unique_ids), BATCH_GET_MAX_KEYS):
        keys = [{"pk": f"CVE#{rid}", "sk": "METADATA"} for rid in unique_ids[start:start + BATCH_GET_MAX_KEYS]]
        request = {TABLE: {"Keys": keys, "ProjectionExpression": ", ".join(names),
                           "ExpressionAttributeNames": names}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            for item in result.get("Responses", {}).get(TABLE, []):
                found[item["pk"][len("CVE#"):]] = item
            request = result.get("UnprocessedKeys") or None
    return found


# --- Writes -------------------------------------------------------------------------

def _transact(items, action, record_id):
    """TransactWriteItems. Returns the indexes of the items whose condition
    failed (empty on success); a cancellation for any other reason is logged
    and becomes a 409 (conflict) or 500."""
    try:
        client.transact_write_items(TransactItems=items)
        return set()
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        reasons = e.response.get("CancellationReasons", [])
        failed = {i for i, r in enumerate(reasons) if r.get("Code") == "ConditionalCheckFailed"}
        if failed:
            return failed
        print(json.dumps({
            "event": f"{action}_transaction_canceled",
            "cveRecordId": record_id,
            "cancellationReasons": [{"code": r.get("Code"), "message": r.get("Message")} for r in reasons],
        }))
        if any(r.get("Code") == "TransactionConflict" for r in reasons):
            raise RequestError(409, "Another change to this CVE is in progress; try again")
        raise RequestError(500, "Failed to save CVE")


def _put(item):
    return {"Put": {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk)"}}


def _condition_check(pk, sk, condition, names=None, values=None):
    check = {"TableName": TABLE, "Key": _key(pk, sk), "ConditionExpression": condition}
    if names:
        check["ExpressionAttributeNames"] = names
    if values:
        check["ExpressionAttributeValues"] = _values(values)
    return {"ConditionCheck": check}


def _update(record_id, expression, condition, names, values):
    return {"Update": {
        "TableName": TABLE,
        "Key": _key(f"CVE#{record_id}", "METADATA"),
        "UpdateExpression": expression,
        "ConditionExpression": condition,
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": _values(values),
    }}


def _delete(pk, sk, condition=None, names=None, values=None):
    spec = {"TableName": TABLE, "Key": _key(pk, sk)}
    if condition:
        spec["ConditionExpression"] = condition
    if names:
        spec["ExpressionAttributeNames"] = names
    if values:
        spec["ExpressionAttributeValues"] = _values(values)
    return {"Delete": spec}


def _item_key(item):
    (spec,) = item.values()
    return spec["Key"]["pk"]["S"], spec["Key"]["sk"]["S"]


def _scope_condition(workspace_id, names, values):
    """The condition that METADATA is still in the scope it was authorized in;
    adds what it needs to names and values."""
    names["#workspaceId"] = "workspaceId"
    if workspace_id is None:
        return "attribute_not_exists(#workspaceId)"
    values[":workspaceId"] = workspace_id
    return "#workspaceId = :workspaceId"


def _caller_check(user_id, record_id, workspace_id):
    """Re-checks inside a transaction that the caller may still change the CVE:
    still a member of its workspace, or still its owner."""
    if workspace_id is not None:
        return _membership_check(user_id, workspace_id)
    return _condition_check(f"USER#{user_id}", f"CVE#{record_id}", "#role = :owner",
                            names={"#role": "role"}, values={":owner": "owner"})


def _log_refusal(event, record_id, **details):
    print(json.dumps({"event": event, "cveRecordId": record_id, **details}))


def _membership_check(user_id, workspace_id):
    roles = {f":role{i}": role for i, role in enumerate(testbed_authz.WORKSPACE_ROLES)}
    return _condition_check(
        f"USER#{user_id}", f"WORKSPACE#{workspace_id}", f"#role IN ({', '.join(roles)})",
        names={"#role": "role"}, values=roles,
    )


def _key(pk, sk):
    return {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)}


def _values(values):
    return {k: serializer.serialize(v) for k, v in values.items()}


# --- Misc ---------------------------------------------------------------------------

def _uuid7():
    # Time-ordered UUID (RFC 9562 version 7), so USER#/CVE# and WORKSPACE#/CVE#
    # rows list newest first with ScanIndexForward=False.
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _utcnow():
    return datetime.now(timezone.utc)


def _iso(value):
    return value.isoformat(timespec="microseconds")


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body),
    }
