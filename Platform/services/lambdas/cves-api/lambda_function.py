"""CVEs: known/public vulnerabilities recorded against the devices under research.

  POST  /cves                   {cveId, severity, ...; workspaceId?}  record a CVE
  GET   /cves                   the caller's personal CVEs
  GET   /cves?workspaceId=...   the CVEs of a workspace the caller belongs to
  GET   /cves/{cveRecordId}     one CVE, with description and references
  PATCH /cves/{cveRecordId}     change its mutable fields

A CVE record has its own id (cveRecordId, a UUIDv7) separate from the public
identifier (cveId, "CVE-2021-37584"): the same public CVE can be recorded once
per scope, Personal or a workspace, so cveId alone doesn't name a record.

Scope works like devices: without a workspaceId the CVE is personal, owned
through USER#/CVE# links; with one, its METADATA carries the workspaceId,
which is what authorizes access (testbed_authz), and it has WORKSPACE#/CVE#
links instead of ownership links. A USER#{uid} / CVEID#{cveId} or
WORKSPACE#{wid} / CVEID#{cveId} claim row, written in the same transaction,
keeps cveId unique per scope.

Device links (CVE#/DEVICE# rows) come in Stage 3B.2.
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
# GET /cves leaves out the long text fields; GET /cves/{id} has everything.
LIST_ATTRIBUTES = ("pk", "cveRecordId", "cveId", "severity", "cvssScore", "cvssVersion", "affectedChipsets",
                   "workspaceId", "createdBy", "createdAt", "updatedAt", "version")

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
        if resource != "/cves/{cveRecordId}":
            return _resp(404, {"error": "Unknown route"})

        record_id = _uuid((event.get("pathParameters") or {}).get("cveRecordId"), "cveRecordId")
        if method == "GET":
            return _resp(200, {"cve": _public_cve(_authorized_cve(table, user_id, record_id))})
        if method == "PATCH":
            return _update_cve(table, user_id, record_id, _json_body(event))
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
        "createdBy": item.get("createdBy"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "version": int(item["version"]) if "version" in item else None,
    }
    if full:
        view["description"] = item.get("description")
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
