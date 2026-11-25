"""Device deletion.

    GET    /devices/{deviceId}/deletion   what deleting the device would remove
    DELETE /devices/{deviceId}            {"confirmName": "<the device's name>"}

and, on an EventBridge schedule, the sweep that finishes deletions an
earlier request couldn't (see _sweep).

Who may delete: testbed_authz.may_delete_device (the owner of a personal
device; for a workspace device a workspace owner or the member who created
it; never a viewer). The caller must also send the device's current name.

How a deletion runs:

1. **Begin**, one transaction: delete DEVICE#/METADATA (conditional on its
   name and scope still being what was checked), the rows that list the
   device (USER#/DEVICE# or WORKSPACE#/DEVICE# and their mirrors), re-check
   the caller's role, and put a tombstone,
   ACTIVE#DEVICE_DELETIONS / DEVICE#{did}. From then on the device is gone
   for every endpoint, and every endpoint that adds a row about a device
   (artifact uploads, CVE links, notebook writes, renames) checks
   DEVICE#/METADATA in its own transaction, so nothing new can be attached
   while the rest is removed.
2. **Cleanup**, from the tombstone, in idempotent steps that can stop and
   resume at any point (a step either finished, or is found again and
   redone):
   - each linked artifact: if another device or a run also uses it, it is
     only unlinked (its file is kept and its key protected); otherwise its
     S3 objects are deleted, then all its rows in one transaction;
   - each CVE link: the link rows and the id in the CVE's deviceIds (the CVE
     record itself is shared and kept);
   - every other DEVICE#{did} row and its mirror (run links, firmware
     version guards, old FIRMWARE# rows);
   - the device's own S3 prefix (devices/{did}/), except protected keys;
   - the RENOTEBOOK#{did} partition (sections, entries, documents).
   The tombstone is deleted last, once both partitions are empty.
3. If a step fails or time runs out, the tombstone stays (with lastError)
   and a lease on it lapses; the request answers 202 and the scheduled
   sweep (or the user repeating the request) carries on.

Every deletion is recorded as structured log events (device_deletion_*),
the platform's audit trail.
"""
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import boto3
import testbed_authz
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
s3 = boto3.client("s3")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
BUCKET = os.environ["DATA_LAKE_BUCKET"]

DELETIONS_PK = "ACTIVE#DEVICE_DELETIONS"
# Longer than the function's timeout, so a lease is never taken over while
# its holder can still be running.
LEASE_SECONDS = 360
# API Gateway answers 504 after 29 s; stop well before and leave the rest to
# the sweep.
API_BUDGET_SECONDS = 20
SWEEP_MARGIN_SECONDS = 30
TRANSACTION_MAX = 100
S3_DELETE_MAX = 1000
CONFLICT_ATTEMPTS = 3
CLEANUP_PASSES = 3

ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ARTIFACT_LINK_PREFIX = "ARTIFACT#"
# Mirrors of DEVICE#{did} / {prefix}{id} rows: {prefix}{id} / DEVICE#{did}.
MIRRORED_PREFIXES = ("USER#", "WORKSPACE#", "RUN#")

NOT_FOUND = {"error": "Device not found"}
NOT_ALLOWED = "Only a workspace owner or the member who created this device can delete it"


class Deadline(Exception):
    """Time is up for this invocation; the deletion resumes later."""


class Forbidden(Exception):
    pass


class CleanupError(Exception):
    pass


class Clock:
    def __init__(self, seconds):
        self.end = time.monotonic() + seconds

    def check(self):
        if time.monotonic() >= self.end:
            raise Deadline()


def handler(event, context):
    if event.get("source") == "aws.events" or event.get("detail-type") == "Scheduled Event":
        return _sweep(context)

    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    device_id = (event.get("pathParameters") or {}).get("deviceId")
    if not isinstance(device_id, str) or not ID_PATTERN.match(device_id):
        return _resp(400, {"error": "deviceId is invalid or missing"})

    table = dynamodb.Table(TABLE)
    method, resource = event.get("httpMethod"), event.get("resource")
    if method == "GET" and resource == "/devices/{deviceId}/deletion":
        return _preview(table, user_id, device_id)
    if method == "DELETE" and resource == "/devices/{deviceId}":
        return _delete(table, user_id, device_id, event.get("body"))
    return _resp(404, {"error": "Not found"})


# --- GET /devices/{deviceId}/deletion -----------------------------------------------

def _preview(table, user_id, device_id):
    device = _get(table, f"DEVICE#{device_id}", "METADATA")
    if device is None:
        return _resp(404, NOT_FOUND)
    try:
        _require_delete(table, user_id, device_id, device)
    except Forbidden as e:
        return _resp(403, {"error": str(e)})
    body = {"deviceId": device_id, "name": device.get("name"), "resources": _survey(table, device_id)}
    if "workspaceId" in device:
        body["workspaceId"] = device["workspaceId"]
    return _resp(200, body)


def _survey(table, device_id):
    """What a deletion removes and keeps, counted the way cleanup decides it."""
    counts = {"firmware": 0, "images": 0, "otherArtifacts": 0, "sharedArtifacts": 0,
              "cves": 0, "runs": 0, "notebookSections": 0, "notebookEntries": 0}
    for row in _query_all(table, f"DEVICE#{device_id}", projection=True):
        sk = row["sk"]
        if sk.startswith(ARTIFACT_LINK_PREFIX):
            artifact_type, artifact_id = _artifact_link(sk)
            plan = _artifact_plan(table, device_id, artifact_id)
            if plan["action"] == "keep":
                counts["sharedArtifacts"] += 1
            elif plan["action"] == "delete":
                key = {"firmware": "firmware", "image": "images"}.get(artifact_type, "otherArtifacts")
                counts[key] += 1
        elif sk.startswith("FIRMWARE#"):
            counts["firmware"] += 1
        elif sk.startswith("CVE#"):
            counts["cves"] += 1
        elif sk.startswith("RUN#"):
            counts["runs"] += 1
    for row in _query_all(table, f"RENOTEBOOK#{device_id}", projection=True, names_extra=("deletedAt",)):
        if row["sk"].startswith("SECTION#"):
            counts["notebookSections"] += 1
        elif row["sk"].startswith("ENTRY#") and "deletedAt" not in row:
            counts["notebookEntries"] += 1
    return counts


# --- DELETE /devices/{deviceId} -----------------------------------------------------

def _delete(table, user_id, device_id, raw_body):
    clock = Clock(API_BUDGET_SECONDS)
    try:
        body = json.loads(raw_body or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})
    confirm = body.get("confirmName") if isinstance(body, dict) else None
    if not isinstance(confirm, str) or not confirm.strip():
        return _resp(400, {"error": "confirmName is required: type the device's name to confirm",
                           "code": "confirmation_required"})

    device = _get(table, f"DEVICE#{device_id}", "METADATA")
    if device is not None:
        try:
            role = _require_delete(table, user_id, device_id, device)
        except Forbidden as e:
            return _resp(403, {"error": str(e)})
        if confirm.strip() != device.get("name"):
            return _resp(400, {"error": "The name typed doesn't match the device's name",
                               "code": "confirmation_mismatch"})
        tombstone, error = _begin(table, user_id, device_id, device, role)
        if error:
            return error
    else:
        # Already begun (a repeated or resumed request): the tombstone holds
        # what is needed to authorize it, since the device's rows are gone.
        tombstone = _get(table, DELETIONS_PK, f"DEVICE#{device_id}")
        if tombstone is None or not _may_resume(table, user_id, tombstone):
            return _resp(404, NOT_FOUND)
        if confirm.strip() != tombstone.get("name"):
            return _resp(400, {"error": "The name typed doesn't match the device's name",
                               "code": "confirmation_mismatch"})
        tombstone = _claim(tombstone)
        if tombstone is None:
            # Another request or the sweep is working on it right now.
            return _resp(202, _result(device_id, pending=True))

    done = _run_cleanup(table, tombstone, clock)
    return _resp(200 if done else 202, _result(device_id, pending=not done, summary=tombstone.get("summary")))


def _result(device_id, pending, summary=None):
    body = {"deviceId": device_id, "deleted": True, "cleanupPending": pending}
    if summary is not None:
        body["resources"] = summary
    return body


def _require_delete(table, user_id, device_id, device):
    """The caller's role, if they may delete the device; raises Forbidden."""
    role = _caller_role(table, user_id, device_id, device)
    if role is None:
        raise Forbidden("Not authorized for this device")
    if not testbed_authz.may_delete_device(role, device, user_id):
        raise Forbidden("Viewers can't delete devices" if role == "viewer" else NOT_ALLOWED)
    return role


def _caller_role(table, user_id, device_id, device):
    if "workspaceId" in device:
        # Only membership counts for a workspace device, never a leftover
        # USER#/DEVICE# row.
        return testbed_authz.workspace_role(table, user_id, device["workspaceId"])
    link = _get(table, f"USER#{user_id}", f"DEVICE#{device_id}")
    return (link or {}).get("role")


def _may_resume(table, user_id, tombstone):
    device = tombstone.get("device") or {}
    if "workspaceId" in device:
        role = testbed_authz.workspace_role(table, user_id, device["workspaceId"])
        return testbed_authz.may_delete_device(role, device, user_id)
    return user_id in (tombstone.get("ownerIds") or [])


def _begin(table, user_id, device_id, device, role):
    """Removes the device and the rows that list it, and puts the tombstone,
    in one transaction. Returns (tombstone, None) or (None, error response)."""
    rows = _query_all(table, f"DEVICE#{device_id}", projection=True)
    workspace_id = device.get("workspaceId")
    now = _now()
    lease_id = str(uuid.uuid4())

    names = {"#name": "name"}
    values = {":name": device.get("name")}
    condition = "attribute_exists(pk) AND #name = :name"
    if workspace_id:
        names["#ws"] = "workspaceId"
        values[":ws"] = workspace_id
        condition += " AND #ws = :ws"
        if role != "owner":
            names["#createdBy"] = "createdBy"
            values[":uid"] = user_id
            condition += " AND #createdBy = :uid"
    else:
        names["#ws"] = "workspaceId"
        condition += " AND attribute_not_exists(#ws)"
    items = [_delete_op(f"DEVICE#{device_id}", "METADATA", condition, names, values)]

    owner_ids = []
    listing = []
    if workspace_id:
        items.append(_check_op(f"USER#{user_id}", f"WORKSPACE#{workspace_id}", "#role = :role",
                               {"#role": "role"}, {":role": role}))
        listing.append(f"WORKSPACE#{workspace_id}")
    else:
        owner_ids = [user_id]
        # The caller's own link is deleted on condition that it still makes
        # them the owner; that is the re-check of their access.
        items.append(_delete_op(f"USER#{user_id}", f"DEVICE#{device_id}", "#role = :owner",
                                {"#role": "role"}, {":owner": "owner"}))
        items.append(_delete_op(f"DEVICE#{device_id}", f"USER#{user_id}"))
    for row in rows:
        sk = row["sk"]
        # Leftover owner rows of a workspace device go too; for a personal
        # device the caller's own link is already in the transaction.
        if sk.startswith("WORKSPACE#") or (sk.startswith("USER#") and (workspace_id or sk != f"USER#{user_id}")):
            listing.append(sk)
    for sk in dict.fromkeys(listing):
        items.append(_delete_op(sk, f"DEVICE#{device_id}"))
        items.append(_delete_op(f"DEVICE#{device_id}", sk))

    summary = _quick_counts(rows)
    tombstone = {
        "pk": DELETIONS_PK, "sk": f"DEVICE#{device_id}", "entity": "device-deletion",
        "deviceId": device_id, "name": device.get("name"),
        "device": {k: v for k, v in device.items() if k not in ("pk", "sk")},
        "ownerIds": owner_ids, "requestedBy": user_id, "requestedAt": now, "summary": summary,
        "attempts": 1, "leaseId": lease_id, "leaseUntil": _later(LEASE_SECONDS),
    }
    if workspace_id:
        tombstone["workspaceId"] = workspace_id
    items.append(_put_op(tombstone, "attribute_not_exists(pk)"))

    if len(items) > TRANSACTION_MAX:
        # Only possible with a corrupted partition (hundreds of owner rows).
        return None, _resp(409, {"error": "This device can't be deleted automatically; contact support"})
    try:
        client.transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        reasons = e.response.get("CancellationReasons", [])
        if len(reasons) > 1 and reasons[1].get("Code") == "ConditionalCheckFailed":
            return None, _resp(403, {"error": "Not authorized for this device"})
        if reasons and reasons[0].get("Code") == "ConditionalCheckFailed":
            current = _get(table, f"DEVICE#{device_id}", "METADATA")
            if current is None:
                return None, _resp(404, NOT_FOUND)
            return None, _resp(409, {"error": "The device changed while you were deleting it. Check it and try again.",
                                     "code": "conflict"})
        return None, _resp(409, {"error": "The device was being changed at the same time; try again",
                                 "code": "busy"})

    _audit("device_deletion_started", tombstone, requestedBy=user_id, role=role, resources=summary)
    return tombstone, None


def _quick_counts(rows):
    """Counts from the device's own partition, for the record of the deletion."""
    counts = {"artifacts": 0, "firmware": 0, "images": 0, "cves": 0, "runs": 0}
    for row in rows:
        sk = row["sk"]
        if sk.startswith(ARTIFACT_LINK_PREFIX):
            counts["artifacts"] += 1
            artifact_type, _ = _artifact_link(sk)
            if artifact_type == "firmware":
                counts["firmware"] += 1
            elif artifact_type == "image":
                counts["images"] += 1
        elif sk.startswith("CVE#"):
            counts["cves"] += 1
        elif sk.startswith("RUN#"):
            counts["runs"] += 1
    return counts


# --- Leases and the sweep ------------------------------------------------------------

def _claim(tombstone):
    """Takes the tombstone's lease if it is free or lapsed; the claimed
    tombstone, or None if someone else holds it."""
    lease_id = str(uuid.uuid4())
    until = _later(LEASE_SECONDS)
    try:
        client.transact_write_items(TransactItems=[_update_op(
            DELETIONS_PK, tombstone["sk"],
            "SET #leaseId = :lease, #leaseUntil = :until, #attempts = #attempts + :one",
            "attribute_exists(pk) AND (attribute_not_exists(#leaseUntil) OR #leaseUntil < :now)",
            {"#leaseId": "leaseId", "#leaseUntil": "leaseUntil", "#attempts": "attempts"},
            {":lease": lease_id, ":until": until, ":one": 1, ":now": _now()},
        )])
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            return None
        raise
    return {**tombstone, "leaseId": lease_id, "leaseUntil": until}


def _release(tombstone, error):
    try:
        client.transact_write_items(TransactItems=[_update_op(
            DELETIONS_PK, tombstone["sk"],
            "SET #lastError = :error, #lastAttemptAt = :now REMOVE #leaseUntil",
            "attribute_exists(pk) AND #leaseId = :lease",
            {"#lastError": "lastError", "#lastAttemptAt": "lastAttemptAt", "#leaseUntil": "leaseUntil",
             "#leaseId": "leaseId"},
            {":error": error, ":now": _now(), ":lease": tombstone["leaseId"]},
        )])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            print(json.dumps({"event": "device_deletion_release_failed", "deviceId": tombstone.get("deviceId"),
                              "error": repr(e)}))


def _sweep(context):
    """Finishes the deletions whose lease has lapsed (a request that ran out
    of time, failed or crashed), oldest first, while time remains."""
    remaining = context.get_remaining_time_in_millis() / 1000 if context else 300
    clock = Clock(max(remaining - SWEEP_MARGIN_SECONDS, 1))
    table = dynamodb.Table(TABLE)
    finished = pending = 0
    for row in sorted(_query_all(table, DELETIONS_PK, "DEVICE#"), key=lambda r: r.get("requestedAt", "")):
        if time.monotonic() >= clock.end:
            break
        claimed = _claim(row)
        if claimed is None:
            continue
        if _run_cleanup(table, claimed, clock):
            finished += 1
        else:
            pending += 1
    return {"finished": finished, "pending": pending}


def _run_cleanup(table, tombstone, clock):
    """True when the deletion is complete. On failure the tombstone keeps the
    error and its lease is released, so the sweep retries."""
    try:
        _cleanup(table, tombstone, clock)
    except Deadline:
        _release(tombstone, "Ran out of time; resumes on the next sweep")
        _audit("device_deletion_pending", tombstone, reason="deadline")
        return False
    except Exception as e:  # noqa: BLE001  anything else is retried by the sweep
        _release(tombstone, repr(e)[:1000])
        _audit("device_deletion_incomplete", tombstone, error=repr(e)[:1000])
        return False
    _audit("device_deleted", tombstone, resources=tombstone.get("summary"))
    return True


# --- Cleanup -----------------------------------------------------------------------

def _cleanup(table, tombstone, clock):
    device_id = tombstone["deviceId"]
    protected = set(tombstone.get("protectedS3Keys") or ())
    for _ in range(CLEANUP_PASSES):
        clock.check()
        rows = _query_all(table, f"DEVICE#{device_id}", projection=True)
        notebook = _query_all(table, f"RENOTEBOOK#{device_id}", projection=True)
        if not rows and not notebook:
            break
        protected |= _clean_artifacts(table, tombstone, rows, protected, clock)
        for row in rows:
            if row["sk"].startswith("CVE#"):
                clock.check()
                _unlink_cve(table, device_id, row["sk"][len("CVE#"):])
        _delete_device_rows(device_id, rows, clock)
        _delete_rows([(r["pk"], r["sk"]) for r in notebook], clock)
    else:
        rows = _query_all(table, f"DEVICE#{device_id}", projection=True)
        notebook = _query_all(table, f"RENOTEBOOK#{device_id}", projection=True)
        if rows or notebook:
            raise CleanupError(f"{len(rows) + len(notebook)} rows still present after {CLEANUP_PASSES} passes")

    # The device's own prefix (old firmware uploads and anything else under
    # it), on every attempt: its objects have no rows that would lead a
    # retry back to them.
    _delete_s3_prefix(f"devices/{device_id}/", protected, clock)

    # Done: the tombstone goes last, and only while this invocation holds it.
    try:
        client.transact_write_items(TransactItems=[_delete_op(
            DELETIONS_PK, tombstone["sk"], "#leaseId = :lease", {"#leaseId": "leaseId"},
            {":lease": tombstone["leaseId"]})])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        # Taken over after our lease lapsed; the other holder finishes it.


def _clean_artifacts(table, tombstone, rows, protected, clock):
    """Unlinks or deletes every artifact linked to the device. Returns the
    S3 keys of the artifacts that are kept, which must never be deleted."""
    device_id = tombstone["deviceId"]
    plans = []
    for row in rows:
        if row["sk"].startswith(ARTIFACT_LINK_PREFIX):
            clock.check()
            _, artifact_id = _artifact_link(row["sk"])
            plans.append((row["sk"], _artifact_plan(table, device_id, artifact_id)))

    kept_keys = set()
    for _, plan in plans:
        if plan["action"] == "keep":
            kept_keys |= _object_keys(plan["metadata"])
    new_keys = kept_keys - protected
    if new_keys:
        # Recorded before anything is unlinked: once a kept artifact's link
        # is gone, a later pass could no longer tell its file is in use.
        _transact([_update_op(DELETIONS_PK, tombstone["sk"], "ADD #protected :keys", "attribute_exists(pk)",
                              {"#protected": "protectedS3Keys"}, {":keys": new_keys})])
    protected = protected | kept_keys

    for link_sk, plan in plans:
        clock.check()
        if plan["action"] == "keep":
            _unlink_artifact(table, device_id, link_sk, plan["artifactId"])
        elif plan["action"] == "delete":
            _delete_artifact(table, device_id, link_sk, plan, protected, clock)
        else:  # the artifact's record is already gone: only the stale link remains
            _delete_rows([(f"DEVICE#{device_id}", link_sk), (f"ARTIFACT#{plan['artifactId']}", f"DEVICE#{device_id}")],
                         clock)
    return kept_keys


def _artifact_plan(table, device_id, artifact_id):
    """keep: another device or a run (input or output) uses the artifact, so
    only this device's link goes. delete: it is the device's alone."""
    rows = _query_all(table, f"ARTIFACT#{artifact_id}")
    metadata = next((r for r in rows if r["sk"] == "METADATA"), None)
    if metadata is None:
        return {"action": "unlink", "artifactId": artifact_id}
    shared = any(
        (r["sk"].startswith("DEVICE#") and r["sk"] != f"DEVICE#{device_id}") or r["sk"].startswith("RUN#")
        for r in rows
    )
    return {"action": "keep" if shared else "delete", "artifactId": artifact_id, "metadata": metadata,
            "rows": rows}


def _object_keys(metadata):
    """Every S3 key an artifact record points to."""
    keys = {metadata.get("s3Key"), (metadata.get("replacement") or {}).get("s3Key")}
    keys |= set(metadata.get("orphanS3Keys") or ())
    return {k for k in keys if isinstance(k, str) and k}


def _unlink_artifact(table, device_id, link_sk, artifact_id):
    """Removes this device from a kept artifact: both link rows and the id in
    its deviceIds (REMOVE when it was the last, never an empty set)."""
    for _ in range(CONFLICT_ATTEMPTS):
        metadata = _get(table, f"ARTIFACT#{artifact_id}", "METADATA") or {}
        items = [_delete_op(f"DEVICE#{device_id}", link_sk),
                 _delete_op(f"ARTIFACT#{artifact_id}", f"DEVICE#{device_id}")]
        device_ids = set(metadata.get("deviceIds") or ())
        if device_id in device_ids:
            items.insert(0, _remove_from_set_op(f"ARTIFACT#{artifact_id}", "deviceIds", device_id,
                                                len(device_ids), extra_set={"#updatedAt": ("updatedAt", _now())}))
        if _transact(items, conflicts_ok=True):
            return
    raise CleanupError(f"artifact {artifact_id} kept changing while it was unlinked")


def _delete_artifact(table, device_id, link_sk, plan, protected, clock):
    """Deletes an artifact only this device used: its S3 objects first (the
    record holds their keys, so a failure here leaves everything to retry),
    then all of its rows and their mirrors in one transaction."""
    artifact_id, metadata = plan["artifactId"], plan["metadata"]
    allowed = (f"artifacts/{artifact_id}/", f"devices/{device_id}/")
    bucket = metadata.get("s3Bucket", BUCKET)
    if bucket == BUCKET:
        explicit = [k for k in _object_keys(metadata) if k.startswith(allowed) and k not in protected]
        _delete_keys(explicit)
        _delete_s3_prefix(f"artifacts/{artifact_id}/", protected, clock)
    else:
        _audit("device_deletion_foreign_bucket", {"deviceId": device_id}, artifactId=artifact_id, bucket=bucket)

    keys = []
    for row in plan["rows"]:
        sk = row["sk"]
        keys.append((f"ARTIFACT#{artifact_id}", sk))
        if sk.startswith(("USER#", "WORKSPACE#")):
            keys.append((sk, f"ARTIFACT#{artifact_id}"))
        elif sk == f"DEVICE#{device_id}":
            keys.append((sk, link_sk))
    keys.append((f"DEVICE#{device_id}", link_sk))
    keys = list(dict.fromkeys(keys))
    items = [_delete_op(pk, sk) for pk, sk in keys]

    batch_id = metadata.get("uploadBatchId")
    if isinstance(batch_id, str) and batch_id and "#" not in batch_id:
        member = _get(table, f"BATCH#{batch_id}", f"ARTIFACT#{artifact_id}")
        batch = _get(table, f"BATCH#{batch_id}", "METADATA")
        if member is not None:
            items.append(_delete_op(f"BATCH#{batch_id}", f"ARTIFACT#{artifact_id}", "attribute_exists(pk)"))
            if batch is not None and "fileCount" in batch and "totalBytes" in batch:
                items.append(_update_op(
                    f"BATCH#{batch_id}", "METADATA",
                    "SET #files = #files + :minusOne, #bytes = #bytes + :minusSize",
                    "attribute_exists(pk)",
                    {"#files": "fileCount", "#bytes": "totalBytes"},
                    {":minusOne": -1, ":minusSize": -int(metadata.get("sizeBytes") or 0)},
                ))
    if len(items) > TRANSACTION_MAX:
        raise CleanupError(f"artifact {artifact_id} has too many rows to delete at once")
    if not _transact(items, conflicts_ok=True):
        raise CleanupError(f"artifact {artifact_id} changed while it was deleted")


def _unlink_cve(table, device_id, record_id):
    """Removes the device from a CVE: both link rows and its id in the CVE's
    deviceIds, with the version bumped as for an unlink. The CVE record is
    shared research and is never deleted."""
    for _ in range(CONFLICT_ATTEMPTS):
        metadata = _get(table, f"CVE#{record_id}", "METADATA") or {}
        items = [_delete_op(f"DEVICE#{device_id}", f"CVE#{record_id}"),
                 _delete_op(f"CVE#{record_id}", f"DEVICE#{device_id}")]
        device_ids = set(metadata.get("deviceIds") or ())
        if device_id in device_ids:
            items.insert(0, _remove_from_set_op(
                f"CVE#{record_id}", "deviceIds", device_id, len(device_ids),
                extra_set={"#updatedAt": ("updatedAt", _now())}, bump_version=True))
        if _transact(items, conflicts_ok=True):
            return
    raise CleanupError(f"CVE {record_id} kept changing while it was unlinked")


def _remove_from_set_op(pk, attribute, value, size, extra_set, bump_version=False):
    names = {"#set": attribute}
    values = {":value": value, ":one": 1}
    sets = []
    for placeholder, (name, v) in extra_set.items():
        names[placeholder] = name
        values[f":{name}"] = v
        sets.append(f"{placeholder} = :{name}")
    if bump_version:
        names["#version"] = "version"
        sets.append("#version = #version + :one")
    if size > 1:
        values[":values"] = {value}
        update = f"SET {', '.join(sets)} DELETE #set :values"
        condition = "attribute_exists(pk) AND contains(#set, :value) AND size(#set) > :one"
    else:
        update = f"SET {', '.join(sets)} REMOVE #set"
        condition = "attribute_exists(pk) AND contains(#set, :value) AND size(#set) = :one"
    return _update_op(pk, "METADATA", update, condition, names, values)


def _delete_device_rows(device_id, rows, clock):
    """Every remaining row of the device's partition, with the mirror rows
    other partitions keep of it (run links). Artifact and CVE links were
    handled above; anything else (firmware version guards, old FIRMWARE#
    rows, rows of a kind added later) belongs to the device alone."""
    keys = []
    for row in rows:
        sk = row["sk"]
        if sk.startswith((ARTIFACT_LINK_PREFIX, "CVE#")):
            continue
        if sk.startswith(MIRRORED_PREFIXES):
            keys.append((sk, f"DEVICE#{device_id}"))
        keys.append((f"DEVICE#{device_id}", sk))
    _delete_rows(keys, clock)


def _delete_rows(keys, clock):
    """Unconditional deletes (repeatable), in transactions of at most 100,
    keeping each row next to its mirror."""
    keys = list(dict.fromkeys(keys))
    for start in range(0, len(keys), TRANSACTION_MAX):
        clock.check()
        chunk = keys[start:start + TRANSACTION_MAX]
        if not _transact([_delete_op(pk, sk) for pk, sk in chunk], conflicts_ok=True):
            raise CleanupError("rows changed while they were deleted")


# --- S3 ------------------------------------------------------------------------------

def _delete_s3_prefix(prefix, protected, clock):
    token = None
    while True:
        clock.check()
        kwargs = {"Bucket": BUCKET, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        _delete_keys([o["Key"] for o in page.get("Contents", []) if o["Key"] not in protected])
        if not page.get("IsTruncated"):
            return
        token = page.get("NextContinuationToken")


def _delete_keys(keys):
    # The bucket is unversioned: DeleteObject removes the bytes for good, and
    # deleting a key that is already gone succeeds, so retries are safe.
    keys = sorted(set(keys))
    for start in range(0, len(keys), S3_DELETE_MAX):
        chunk = keys[start:start + S3_DELETE_MAX]
        response = s3.delete_objects(Bucket=BUCKET, Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
        errors = response.get("Errors") or []
        if errors:
            raise CleanupError(f"S3 refused to delete {len(errors)} object(s), e.g. {errors[0].get('Key')}: "
                               f"{errors[0].get('Code')}")


# --- DynamoDB helpers ---------------------------------------------------------------

def _get(table, pk, sk):
    return table.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item")


def _query_all(table, pk, prefix="", projection=False, names_extra=()):
    """Every row of a partition (or of an sk prefix), strongly consistent.
    With projection, only the keys (and names_extra) are read, so large
    rows such as notebook documents aren't."""
    condition = Key("pk").eq(pk) & Key("sk").begins_with(prefix) if prefix else Key("pk").eq(pk)
    kwargs = {"KeyConditionExpression": condition, "ConsistentRead": True}
    if projection:
        names = {"#pk": "pk", "#sk": "sk", **{f"#x{i}": n for i, n in enumerate(names_extra)}}
        kwargs["ProjectionExpression"] = ", ".join(names)
        kwargs["ExpressionAttributeNames"] = names
    items = []
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _transact(items, conflicts_ok=False):
    """True when written. With conflicts_ok, a cancelled transaction (a
    condition or a concurrent write) returns False for the caller to retry."""
    try:
        client.transact_write_items(TransactItems=items)
        return True
    except ClientError as e:
        if conflicts_ok and e.response["Error"]["Code"] == "TransactionCanceledException":
            return False
        raise


def _key(pk, sk):
    return {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)}


def _with_expression(spec, condition, names, values):
    if condition:
        spec["ConditionExpression"] = condition
    if names:
        spec["ExpressionAttributeNames"] = names
    if values:
        spec["ExpressionAttributeValues"] = {k: serializer.serialize(v) for k, v in values.items()}
    return spec


def _delete_op(pk, sk, condition=None, names=None, values=None):
    return {"Delete": _with_expression({"TableName": TABLE, "Key": _key(pk, sk)}, condition, names, values)}


def _check_op(pk, sk, condition, names, values):
    return {"ConditionCheck": _with_expression({"TableName": TABLE, "Key": _key(pk, sk)}, condition, names, values)}


def _update_op(pk, sk, update, condition, names, values):
    spec = {"TableName": TABLE, "Key": _key(pk, sk), "UpdateExpression": update}
    return {"Update": _with_expression(spec, condition, names, values)}


def _put_op(item, condition):
    spec = {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
            "ConditionExpression": condition}
    return {"Put": spec}


# --- Misc ----------------------------------------------------------------------------

def _artifact_link(sk):
    """DEVICE#/ARTIFACT#{type}#{artifactId} -> (type, artifactId)."""
    rest = sk[len(ARTIFACT_LINK_PREFIX):]
    artifact_type, _, artifact_id = rest.rpartition("#")
    return artifact_type, artifact_id


def _audit(event, tombstone, **fields):
    record = {"event": event, "deviceId": tombstone.get("deviceId"), "name": tombstone.get("name"),
              "workspaceId": tombstone.get("workspaceId"), "requestedBy": tombstone.get("requestedBy"),
              "requestedAt": tombstone.get("requestedAt"), "at": _now(), **fields}
    print(json.dumps({k: v for k, v in record.items() if v is not None}, default=str))


def _utcnow():
    return datetime.now(timezone.utc)


def _now():
    # Always with microseconds, so lease times compare correctly as strings.
    return _utcnow().isoformat(timespec="microseconds")


def _later(seconds):
    return (_utcnow() + timedelta(seconds=seconds)).isoformat(timespec="microseconds")


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(value):
    # DynamoDB numbers come back as Decimal.
    if hasattr(value, "to_integral_value"):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"not serializable: {type(value)}")
