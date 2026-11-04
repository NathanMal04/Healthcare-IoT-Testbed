"""RE Notebook: each device's reverse-engineering notebook.

A device has exactly one notebook, made of ordered sections, each holding
ordered research entries. An entry's content is a structured document (see
re_notebook_doc.py), never HTML.

  GET    /devices/{deviceId}/notebook                               sections and entries (no content)
  POST   /devices/{deviceId}/notebook/sections                      {title}
  PATCH  /devices/{deviceId}/notebook/sections/{sectionId}          {title, expectedVersion}
  DELETE /devices/{deviceId}/notebook/sections/{sectionId}?expectedVersion=   empty sections only
  PUT    /devices/{deviceId}/notebook/section-order                 {sectionIds, expectedOrderVersion}
  POST   /devices/{deviceId}/notebook/sections/{sectionId}/entries  {title}
  PUT    /devices/{deviceId}/notebook/sections/{sectionId}/entry-order  {entryIds, expectedOrderVersion}
  GET    /devices/{deviceId}/notebook/entries/{entryId}             the entry with its document
  PATCH  /devices/{deviceId}/notebook/entries/{entryId}             {title, expectedVersion}
  PUT    /devices/{deviceId}/notebook/entries/{entryId}/content     {doc, expectedContentVersion}
  POST   /devices/{deviceId}/notebook/entries/{entryId}/move        {targetSectionId, expectedVersion, position?}
  DELETE /devices/{deviceId}/notebook/entries/{entryId}?expectedVersion=&expectedContentVersion=

Storage: one partition per notebook, RENOTEBOOK#{deviceId}, with METADATA
(the section order), SECTION#{sid} (title and the section's entry order),
ENTRY#{eid} (title, placement, authorship; no body) and CONTENT#{eid} (the
document). Nothing in it records the device's scope: every request is
authorized against DEVICE#{deviceId}/METADATA with the same rule as editing
the device (testbed_authz: the owner of a personal device, any member of a
workspace device's workspace), and every write re-checks in its transaction
that the device is still in that scope and the caller still has access.

Concurrency: titles and placement are versioned (version), documents are
versioned separately (contentVersion), and order lists by orderVersion.
Writes from a client name the version they started from and get 409 with the
current state when it moved on, so nobody's change is silently overwritten.
Order lists that the server computes (adding, moving or deleting an entry,
adding or deleting a section) are re-read and retried a few times instead,
as the caller's intent doesn't depend on the exact list.

Entries are soft-deleted: deletedAt is set and the entry leaves its section's
order, while both rows are kept. Every write to an entry requires it not to
be deleted, so a stale request can neither edit nor bring one back.
"""
import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone

import boto3
import re_notebook_doc
import testbed_authz
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]

MAX_SECTIONS = 50
MAX_ENTRIES_PER_SECTION = 200
TITLE_MAX_LENGTH = 200
NAME_MAX_LENGTH = 120
# The document has its own, smaller limit (re_notebook_doc.MAX_BYTES); this
# only bounds the work done on an oversized request.
MAX_BODY_BYTES = 1024 * 1024
ORDER_RETRIES = 3

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

BASE = "/devices/{deviceId}/notebook"
R_NOTEBOOK = BASE
R_SECTIONS = BASE + "/sections"
R_SECTION = BASE + "/sections/{sectionId}"
R_SECTION_ORDER = BASE + "/section-order"
R_SECTION_ENTRIES = BASE + "/sections/{sectionId}/entries"
R_ENTRY_ORDER = BASE + "/sections/{sectionId}/entry-order"
R_ENTRY = BASE + "/entries/{entryId}"
R_ENTRY_CONTENT = BASE + "/entries/{entryId}/content"
R_ENTRY_MOVE = BASE + "/entries/{entryId}/move"

NOTEBOOK_BUSY = "The notebook is being changed by someone else at the same time; try again"


class RequestError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


class Context:
    """The authorized caller and device of one request."""

    def __init__(self, table, user_id, name, device_id, workspace_id):
        self.table = table
        self.user_id = user_id
        self.name = name
        self.device_id = device_id
        self.workspace_id = workspace_id
        self.pk = f"RENOTEBOOK#{device_id}"


def handler(event, context):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        return _resp(401, {"error": "Unauthorized"})

    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    path = event.get("pathParameters") or {}
    query = event.get("queryStringParameters") or {}
    table = dynamodb.Table(TABLE)

    try:
        route = (method, resource)
        if route not in ROUTES:
            return _resp(404, {"error": "Unknown route"})
        device_id = _uuid(path.get("deviceId"), "deviceId")
        ids = {name: _uuid(path.get(name), name) for name in ("sectionId", "entryId") if f"{{{name}}}" in resource}
        ctx = _authorize(table, user_id, _display_name(claims), device_id, read_only=method == "GET")
        body = _json_body(event) if method in ("POST", "PUT", "PATCH") else None
        return ROUTES[route](ctx, ids, body, query)
    except RequestError as e:
        return _resp(e.status, {"error": e.message, **e.extra})


def _authorize(table, user_id, name, device_id, read_only=False):
    # The device-edit rule: the owner of a personal device, or any
    # contributor of a workspace device's workspace (a leftover USER#/DEVICE#
    # row on a workspace device grants nothing). Reads (GET) also accept the
    # workspace's viewers; every write keeps the contributor rule, here and
    # in its transaction (_guards). The same 404 whether the device is
    # missing or not the caller's, so ids aren't revealed.
    roles = testbed_authz.MEMBERSHIP_ROLES if read_only else testbed_authz.CONTRIBUTOR_ROLES
    try:
        device = testbed_authz.require_resource(table, user_id, "DEVICE", device_id, legacy_roles=("owner",),
                                                workspace_roles=roles)
    except testbed_authz.AuthorizationError:
        raise RequestError(404, "Device not found")
    return Context(table, user_id, name, device_id, device.get("workspaceId"))


# --- Notebook and sections -----------------------------------------------------------

def _get_notebook(ctx, ids, body, query):
    return _resp(200, {"notebook": _notebook_view(ctx)})


def _create_section(ctx, ids, body, query):
    _reject_fields(body, {"title"})
    title = _title(body.get("title"))
    section_id = _uuid7()
    now = _now()
    section = {
        "pk": ctx.pk, "sk": f"SECTION#{section_id}", "entity": "re-notebook-section",
        "deviceId": ctx.device_id, "sectionId": section_id, "title": title, "entryIds": [],
        "version": 1, "orderVersion": 0, **_created(ctx, now),
    }
    for _ in range(ORDER_RETRIES):
        meta = _get(ctx, "METADATA")
        if meta is None:
            order = {"pk": ctx.pk, "sk": "METADATA", "entity": "re-notebook", "deviceId": ctx.device_id,
                     "sectionIds": [section_id], "orderVersion": 1, **_created(ctx, now)}
            order_item = _put(order)
        else:
            section_ids = list(meta.get("sectionIds") or [])
            if len(section_ids) >= MAX_SECTIONS:
                raise RequestError(409, f"A notebook can have at most {MAX_SECTIONS} sections", {"code": "limit"})
            order_item = _set_order(ctx, "METADATA", "sectionIds", section_ids + [section_id], meta)
        failed = _transact(ctx, [order_item, _put(section)], "create_section")
        if not failed:
            return _resp(201, {"sectionId": section_id, "notebook": _notebook_view(ctx)})
    raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})


def _rename_section(ctx, ids, body, query):
    _reject_fields(body, {"title", "expectedVersion"})
    title = _title(body.get("title"))
    expected = _version(body.get("expectedVersion"), "expectedVersion")
    sk = f"SECTION#{ids['sectionId']}"
    names, values = {}, {":expected": expected}
    update = _update(ctx, sk, "SET #title = :title, #version = #version + :one, " + _touch(ctx, names, values),
                     "attribute_exists(pk) AND #version = :expected",
                     {**names, "#title": "title", "#version": "version"},
                     {**values, ":title": title, ":one": 1})
    if _transact(ctx, [update], "rename_section"):
        _section_conflict(ctx, ids["sectionId"])
    return _resp(200, {"notebook": _notebook_view(ctx)})


def _delete_section(ctx, ids, body, query):
    expected = _version(query.get("expectedVersion"), "expectedVersion")
    section_id = ids["sectionId"]
    for _ in range(ORDER_RETRIES):
        section = _get(ctx, f"SECTION#{section_id}")
        if section is None:
            raise RequestError(404, "Section not found")
        if int(section.get("version", 0)) != expected:
            raise RequestError(409, "The section was changed by someone else; review it before deleting it",
                               {"code": "conflict", "section": _section_view(section, [])})
        if section.get("entryIds"):
            # Entries are never deleted along with their section: each one is
            # deleted (or moved) on its own first.
            raise RequestError(409, "Only an empty section can be deleted; move or delete its entries first",
                               {"code": "not_empty"})
        meta = _get(ctx, "METADATA") or {}
        section_ids = [sid for sid in meta.get("sectionIds") or [] if sid != section_id]
        delete = _delete(ctx, f"SECTION#{section_id}",
                         "attribute_exists(pk) AND #version = :expected AND size(#entryIds) = :zero",
                         {"#version": "version", "#entryIds": "entryIds"}, {":expected": expected, ":zero": 0})
        failed = _transact(ctx, [delete, _set_order(ctx, "METADATA", "sectionIds", section_ids, meta)],
                           "delete_section")
        if not failed:
            return _resp(200, {"notebook": _notebook_view(ctx)})
        # Re-read: the checks above then give the precise answer.
    raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})


def _reorder_sections(ctx, ids, body, query):
    _reject_fields(body, {"sectionIds", "expectedOrderVersion"})
    expected = _version(body.get("expectedOrderVersion"), "expectedOrderVersion")
    requested = _id_list(body.get("sectionIds"), "sectionIds")
    meta = _get(ctx, "METADATA")
    current = list((meta or {}).get("sectionIds") or [])
    if meta is None or int(meta.get("orderVersion", 0)) != expected or sorted(requested) != sorted(current):
        raise RequestError(409, "The notebook was changed by someone else; reload it and try again",
                           {"code": "stale_order", "notebook": _notebook_view(ctx)})
    if _transact(ctx, [_set_order(ctx, "METADATA", "sectionIds", requested, meta)], "reorder_sections"):
        raise RequestError(409, "The notebook was changed by someone else; reload it and try again",
                           {"code": "stale_order", "notebook": _notebook_view(ctx)})
    return _resp(200, {"notebook": _notebook_view(ctx)})


# --- Entries --------------------------------------------------------------------------

def _create_entry(ctx, ids, body, query):
    _reject_fields(body, {"title"})
    title = _title(body.get("title"))
    section_id = ids["sectionId"]
    entry_id = _uuid7()
    now = _now()
    doc, _ = re_notebook_doc.validate(re_notebook_doc.EMPTY_DOC)
    entry = {
        "pk": ctx.pk, "sk": f"ENTRY#{entry_id}", "entity": "re-notebook-entry", "deviceId": ctx.device_id,
        "entryId": entry_id, "sectionId": section_id, "title": title, "version": 1, "contentVersion": 1,
        "textLength": 0, **_created(ctx, now), **_content_touched(ctx, now),
    }
    content = {
        "pk": ctx.pk, "sk": f"CONTENT#{entry_id}", "entity": "re-notebook-content", "entryId": entry_id,
        "doc": doc, "schemaVersion": re_notebook_doc.SCHEMA_VERSION, "contentVersion": 1,
        "updatedAt": now, "updatedBy": ctx.user_id,
    }
    for _ in range(ORDER_RETRIES):
        section = _get(ctx, f"SECTION#{section_id}")
        if section is None:
            raise RequestError(404, "Section not found")
        entry_ids = list(section.get("entryIds") or [])
        if len(entry_ids) >= MAX_ENTRIES_PER_SECTION:
            raise RequestError(409, f"A section can have at most {MAX_ENTRIES_PER_SECTION} entries",
                               {"code": "limit"})
        order = _set_order(ctx, f"SECTION#{section_id}", "entryIds", entry_ids + [entry_id], section)
        if not _transact(ctx, [order, _put(entry), _put(content)], "create_entry"):
            return _resp(201, {"entryId": entry_id, "notebook": _notebook_view(ctx)})
    raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})


def _reorder_entries(ctx, ids, body, query):
    _reject_fields(body, {"entryIds", "expectedOrderVersion"})
    expected = _version(body.get("expectedOrderVersion"), "expectedOrderVersion")
    requested = _id_list(body.get("entryIds"), "entryIds")
    sk = f"SECTION#{ids['sectionId']}"
    section = _get(ctx, sk)
    if section is None:
        raise RequestError(404, "Section not found")
    current = list(section.get("entryIds") or [])
    stale = RequestError(409, "The section was changed by someone else; reload it and try again",
                         {"code": "stale_order"})
    if int(section.get("orderVersion", 0)) != expected or sorted(requested) != sorted(current):
        stale.extra["notebook"] = _notebook_view(ctx)
        raise stale
    if _transact(ctx, [_set_order(ctx, sk, "entryIds", requested, section)], "reorder_entries"):
        stale.extra["notebook"] = _notebook_view(ctx)
        raise stale
    return _resp(200, {"notebook": _notebook_view(ctx)})


def _get_entry(ctx, ids, body, query):
    entry = _live_entry(ctx, ids["entryId"])
    content = _get(ctx, f"CONTENT#{ids['entryId']}")
    if content is None:
        raise RequestError(500, "The entry's content is missing")
    return _resp(200, {"entry": _entry_view(entry), "doc": json.loads(content["doc"]),
                       "schemaVersion": int(content.get("schemaVersion", 1))})


def _rename_entry(ctx, ids, body, query):
    _reject_fields(body, {"title", "expectedVersion"})
    title = _title(body.get("title"))
    expected = _version(body.get("expectedVersion"), "expectedVersion")
    names, values = {"#title": "title", "#version": "version", "#deletedAt": "deletedAt"}, {}
    update = _update(ctx, f"ENTRY#{ids['entryId']}",
                     "SET #title = :title, #version = #version + :one, " + _touch(ctx, names, values),
                     "attribute_exists(pk) AND attribute_not_exists(#deletedAt) AND #version = :expected",
                     names, {**values, ":title": title, ":one": 1, ":expected": expected})
    if _transact(ctx, [update], "rename_entry"):
        _entry_conflict(ctx, ids["entryId"], "The entry was changed by someone else; review it and try again")
    return _resp(200, {"entry": _entry_view(_get(ctx, f"ENTRY#{ids['entryId']}")),
                       "notebook": _notebook_view(ctx)})


def _save_content(ctx, ids, body, query):
    """Autosave. Conditional on the contentVersion the editor started from:
    if someone else saved meanwhile, nothing is written and the 409 carries
    their version, for the editor to show next to the unsaved one."""
    _reject_fields(body, {"doc", "expectedContentVersion"})
    expected = _version(body.get("expectedContentVersion"), "expectedContentVersion")
    try:
        doc, text_length = re_notebook_doc.validate(body.get("doc"))
    except re_notebook_doc.DocumentError as e:
        raise RequestError(400, str(e), {"code": "invalid_document"})
    entry_id = ids["entryId"]
    now = _now()
    new_version = expected + 1

    names = {"#contentVersion": "contentVersion", "#textLength": "textLength", "#deletedAt": "deletedAt"}
    values = {":expected": expected, ":new": new_version, ":textLength": text_length}
    touch = _touch(ctx, names, values, now) + ", " + _touch_content(ctx, names, values, now)
    entry_update = _update(ctx, f"ENTRY#{entry_id}",
                           f"SET #contentVersion = :new, #textLength = :textLength, {touch}",
                           "attribute_exists(pk) AND attribute_not_exists(#deletedAt) "
                           "AND #contentVersion = :expected",
                           names, values)
    content_update = _update(ctx, f"CONTENT#{entry_id}",
                             "SET #doc = :doc, #schemaVersion = :schemaVersion, #contentVersion = :new, "
                             "#updatedAt = :now, #updatedBy = :uid",
                             "attribute_exists(pk) AND #contentVersion = :expected",
                             {"#doc": "doc", "#schemaVersion": "schemaVersion", "#contentVersion": "contentVersion",
                              "#updatedAt": "updatedAt", "#updatedBy": "updatedBy"},
                             {":doc": doc, ":schemaVersion": re_notebook_doc.SCHEMA_VERSION, ":new": new_version,
                              ":expected": expected, ":now": now, ":uid": ctx.user_id})
    if _transact(ctx, [entry_update, content_update], "save_content"):
        entry = _live_entry(ctx, entry_id)
        content = _get(ctx, f"CONTENT#{entry_id}")
        raise RequestError(409, "This entry was changed by someone else while you were editing it",
                           {"code": "conflict", "entry": _entry_view(entry),
                            "doc": json.loads(content["doc"]) if content else None})
    return _resp(200, {"entry": _entry_view(_get(ctx, f"ENTRY#{entry_id}"))})


def _move_entry(ctx, ids, body, query):
    _reject_fields(body, {"targetSectionId", "expectedVersion", "position"})
    target_id = _uuid(body.get("targetSectionId"), "targetSectionId")
    expected = _version(body.get("expectedVersion"), "expectedVersion")
    position = body.get("position")
    if position is not None and (not isinstance(position, int) or isinstance(position, bool) or position < 0):
        raise RequestError(400, "position must be a non-negative integer")
    entry_id = ids["entryId"]
    for _ in range(ORDER_RETRIES):
        entry = _live_entry(ctx, entry_id)
        if int(entry.get("version", 0)) != expected:
            raise RequestError(409, "The entry was changed by someone else; review it and try again",
                               {"code": "conflict", "entry": _entry_view(entry)})
        source_id = entry["sectionId"]
        if source_id == target_id:
            raise RequestError(400, "The entry is already in that section; reorder it instead")
        source = _get(ctx, f"SECTION#{source_id}")
        target = _get(ctx, f"SECTION#{target_id}")
        if target is None:
            raise RequestError(404, "Section not found")
        if source is None:
            raise RequestError(500, "The entry's section is missing")
        target_ids = list(target.get("entryIds") or [])
        if len(target_ids) >= MAX_ENTRIES_PER_SECTION:
            raise RequestError(409, f"A section can have at most {MAX_ENTRIES_PER_SECTION} entries",
                               {"code": "limit"})
        index = len(target_ids) if position is None else min(position, len(target_ids))
        target_ids.insert(index, entry_id)
        source_ids = [eid for eid in source.get("entryIds") or [] if eid != entry_id]

        names = {"#sectionId": "sectionId", "#version": "version", "#deletedAt": "deletedAt"}
        values = {":target": target_id, ":source": source_id, ":expected": expected, ":one": 1}
        move = _update(ctx, f"ENTRY#{entry_id}",
                       "SET #sectionId = :target, #version = #version + :one, " + _touch(ctx, names, values),
                       "attribute_exists(pk) AND attribute_not_exists(#deletedAt) AND #version = :expected "
                       "AND #sectionId = :source",
                       names, values)
        failed = _transact(ctx, [
            move,
            _set_order(ctx, f"SECTION#{source_id}", "entryIds", source_ids, source),
            _set_order(ctx, f"SECTION#{target_id}", "entryIds", target_ids, target),
        ], "move_entry")
        if not failed:
            return _resp(200, {"entry": _entry_view(_get(ctx, f"ENTRY#{entry_id}")),
                               "notebook": _notebook_view(ctx)})
        if 0 in failed:
            _entry_conflict(ctx, entry_id, "The entry was changed by someone else; review it and try again")
    raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})


def _delete_entry(ctx, ids, body, query):
    """Soft delete: the entry gets deletedAt and leaves its section's order;
    its rows (and document) are kept, for a later trash/restore."""
    expected = _version(query.get("expectedVersion"), "expectedVersion")
    expected_content = _version(query.get("expectedContentVersion"), "expectedContentVersion")
    entry_id = ids["entryId"]
    for _ in range(ORDER_RETRIES):
        entry = _live_entry(ctx, entry_id)
        if int(entry.get("version", 0)) != expected or int(entry.get("contentVersion", 0)) != expected_content:
            raise RequestError(409, "The entry was changed by someone else; review it before deleting it",
                               {"code": "conflict", "entry": _entry_view(entry)})
        section_id = entry["sectionId"]
        section = _get(ctx, f"SECTION#{section_id}")
        if section is None:
            raise RequestError(500, "The entry's section is missing")
        now = _now()
        names = {"#version": "version", "#contentVersion": "contentVersion", "#deletedAt": "deletedAt",
                 "#deletedBy": "deletedBy", "#deletedByName": "deletedByName", "#sectionId": "sectionId"}
        values = {":expected": expected, ":expectedContent": expected_content, ":one": 1, ":now": now,
                  ":uid": ctx.user_id, ":name": ctx.name, ":section": section_id}
        delete = _update(ctx, f"ENTRY#{entry_id}",
                         "SET #deletedAt = :now, #deletedBy = :uid, #deletedByName = :name, "
                         "#version = #version + :one",
                         "attribute_exists(pk) AND attribute_not_exists(#deletedAt) AND #version = :expected "
                         "AND #contentVersion = :expectedContent AND #sectionId = :section",
                         names, values)
        remaining = [eid for eid in section.get("entryIds") or [] if eid != entry_id]
        failed = _transact(ctx, [delete, _set_order(ctx, f"SECTION#{section_id}", "entryIds", remaining, section)],
                           "delete_entry")
        if not failed:
            return _resp(200, {"notebook": _notebook_view(ctx)})
        if 0 in failed:
            _entry_conflict(ctx, entry_id, "The entry was changed by someone else; review it before deleting it")
    raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})


ROUTES = {
    ("GET", R_NOTEBOOK): _get_notebook,
    ("POST", R_SECTIONS): _create_section,
    ("PATCH", R_SECTION): _rename_section,
    ("DELETE", R_SECTION): _delete_section,
    ("PUT", R_SECTION_ORDER): _reorder_sections,
    ("POST", R_SECTION_ENTRIES): _create_entry,
    ("PUT", R_ENTRY_ORDER): _reorder_entries,
    ("GET", R_ENTRY): _get_entry,
    ("PATCH", R_ENTRY): _rename_entry,
    ("DELETE", R_ENTRY): _delete_entry,
    ("PUT", R_ENTRY_CONTENT): _save_content,
    ("POST", R_ENTRY_MOVE): _move_entry,
}


# --- Reads and views ------------------------------------------------------------------

def _get(ctx, sk):
    return ctx.table.get_item(Key={"pk": ctx.pk, "sk": sk}, ConsistentRead=True).get("Item")


def _query(ctx, prefix):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(ctx.pk) & Key("sk").begins_with(prefix),
                         "ConsistentRead": True}
    while True:
        page = ctx.table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _live_entry(ctx, entry_id):
    entry = _get(ctx, f"ENTRY#{entry_id}")
    if entry is None:
        raise RequestError(404, "Entry not found")
    if "deletedAt" in entry:
        raise RequestError(404, "This entry was deleted", {
            "code": "deleted", "deletedAt": entry.get("deletedAt"), "deletedByName": entry.get("deletedByName"),
        })
    return entry


def _notebook_view(ctx):
    """The notebook's structure, read consistently: ordered sections with
    their ordered (live) entries. Rows missing from an order list (which the
    transactions never leave) are shown after the listed ones rather than
    hidden."""
    meta = _get(ctx, "METADATA") or {}
    sections = {s["sectionId"]: s for s in _query(ctx, "SECTION#")}
    entries = [e for e in _query(ctx, "ENTRY#") if "deletedAt" not in e]
    by_section = {}
    for entry in entries:
        by_section.setdefault(entry.get("sectionId"), []).append(entry)

    section_order = [sid for sid in meta.get("sectionIds") or [] if sid in sections]
    section_order += sorted(set(sections) - set(section_order))
    views = []
    for section_id in section_order:
        section = sections[section_id]
        own = {e["entryId"]: e for e in by_section.get(section_id, [])}
        entry_order = [eid for eid in section.get("entryIds") or [] if eid in own]
        entry_order += sorted(set(own) - set(entry_order))
        views.append(_section_view(section, [_entry_view(own[eid]) for eid in entry_order]))
    return {
        "deviceId": ctx.device_id,
        "orderVersion": int(meta.get("orderVersion", 0)),
        "sections": views,
        "limits": {"sections": MAX_SECTIONS, "entriesPerSection": MAX_ENTRIES_PER_SECTION,
                   "titleLength": TITLE_MAX_LENGTH, "documentBytes": re_notebook_doc.MAX_BYTES},
    }


def _section_view(section, entries):
    return {
        "sectionId": section["sectionId"],
        "title": section.get("title"),
        "version": int(section.get("version", 0)),
        "orderVersion": int(section.get("orderVersion", 0)),
        **_authorship(section),
        "entries": entries,
    }


def _entry_view(entry):
    view = {
        "entryId": entry["entryId"],
        "sectionId": entry.get("sectionId"),
        "title": entry.get("title"),
        "version": int(entry.get("version", 0)),
        "contentVersion": int(entry.get("contentVersion", 0)),
        "textLength": int(entry.get("textLength", 0)),
        **_authorship(entry),
        "contentUpdatedBy": entry.get("contentUpdatedBy"),
        "contentUpdatedByName": entry.get("contentUpdatedByName"),
        "contentUpdatedAt": entry.get("contentUpdatedAt"),
    }
    return view


def _authorship(item):
    return {key: item.get(key) for key in ("createdBy", "createdByName", "createdAt",
                                           "updatedBy", "updatedByName", "updatedAt")}


def _section_conflict(ctx, section_id):
    section = _get(ctx, f"SECTION#{section_id}")
    if section is None:
        raise RequestError(404, "Section not found")
    raise RequestError(409, "The section was changed by someone else; review it and try again",
                       {"code": "conflict", "section": _section_view(section, [])})


def _entry_conflict(ctx, entry_id, message):
    entry = _live_entry(ctx, entry_id)
    raise RequestError(409, message, {"code": "conflict", "entry": _entry_view(entry)})


# --- Writes ---------------------------------------------------------------------------

def _transact(ctx, items, action):
    """Runs the items plus the access guards in one transaction. Returns the
    indexes (into `items`) whose condition failed; empty on success. A failed
    guard means the caller lost access or the device changed scope: 404."""
    guards = _guards(ctx)
    try:
        client.transact_write_items(TransactItems=items + guards)
        return set()
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        reasons = e.response.get("CancellationReasons", [])
        failed = {i for i, r in enumerate(reasons) if r.get("Code") == "ConditionalCheckFailed"}
        if any(i >= len(items) for i in failed):
            raise RequestError(404, "Device not found")
        if failed:
            return failed
        print(json.dumps({
            "event": f"{action}_transaction_canceled", "deviceId": ctx.device_id,
            "cancellationReasons": [{"code": r.get("Code"), "message": r.get("Message")} for r in reasons],
        }))
        if any(r.get("Code") == "TransactionConflict" for r in reasons):
            raise RequestError(409, NOTEBOOK_BUSY, {"code": "busy"})
        raise RequestError(500, "Failed to save the notebook")


def _guards(ctx):
    """Re-checks inside each write that the device is still in the scope it
    was authorized in, and that the caller still has access to it: still a
    member of its workspace, or still its owner."""
    names, values = {"#workspaceId": "workspaceId"}, {}
    if ctx.workspace_id is None:
        device_condition = "attribute_exists(pk) AND attribute_not_exists(#workspaceId)"
    else:
        device_condition = "#workspaceId = :workspaceId"
        values[":workspaceId"] = ctx.workspace_id
    device = _condition_check(f"DEVICE#{ctx.device_id}", "METADATA", device_condition, names, values)
    if ctx.workspace_id is not None:
        roles = {f":role{i}": role for i, role in enumerate(testbed_authz.WORKSPACE_ROLES)}
        caller = _condition_check(f"USER#{ctx.user_id}", f"WORKSPACE#{ctx.workspace_id}",
                                  f"#role IN ({', '.join(roles)})", {"#role": "role"}, roles)
    else:
        caller = _condition_check(f"USER#{ctx.user_id}", f"DEVICE#{ctx.device_id}", "#role = :owner",
                                  {"#role": "role"}, {":owner": "owner"})
    return [device, caller]


def _set_order(ctx, sk, attribute, ids, current):
    """Replaces an order list, conditional on the orderVersion it was read
    at (absent counts as 0)."""
    names = {"#list": attribute, "#orderVersion": "orderVersion"}
    values = {":ids": ids, ":read": int((current or {}).get("orderVersion", 0)), ":next":
              int((current or {}).get("orderVersion", 0)) + 1}
    condition = "attribute_exists(pk) AND #orderVersion = :read"
    if values[":read"] == 0:
        condition = "attribute_exists(pk) AND (attribute_not_exists(#orderVersion) OR #orderVersion = :read)"
    return _update(ctx, sk, "SET #list = :ids, #orderVersion = :next, " + _touch(ctx, names, values),
                   condition, names, values)


def _touch(ctx, names, values, now=None):
    names.update({"#updatedAt": "updatedAt", "#updatedBy": "updatedBy", "#updatedByName": "updatedByName"})
    values.update({":now": now or _now(), ":uid": ctx.user_id, ":name": ctx.name})
    return "#updatedAt = :now, #updatedBy = :uid, #updatedByName = :name"


def _touch_content(ctx, names, values, now):
    names.update({"#contentUpdatedAt": "contentUpdatedAt", "#contentUpdatedBy": "contentUpdatedBy",
                  "#contentUpdatedByName": "contentUpdatedByName"})
    values.update({":now": now, ":uid": ctx.user_id, ":name": ctx.name})
    return "#contentUpdatedAt = :now, #contentUpdatedBy = :uid, #contentUpdatedByName = :name"


def _created(ctx, now):
    return {"createdBy": ctx.user_id, "createdByName": ctx.name, "createdAt": now,
            "updatedBy": ctx.user_id, "updatedByName": ctx.name, "updatedAt": now}


def _content_touched(ctx, now):
    return {"contentUpdatedBy": ctx.user_id, "contentUpdatedByName": ctx.name, "contentUpdatedAt": now}


def _put(item):
    return {"Put": {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk)"}}


def _update(ctx, sk, expression, condition, names, values):
    return {"Update": {
        "TableName": TABLE, "Key": _key(ctx.pk, sk), "UpdateExpression": expression,
        "ConditionExpression": condition, "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": _values(values),
    }}


def _delete(ctx, sk, condition, names, values):
    return {"Delete": {
        "TableName": TABLE, "Key": _key(ctx.pk, sk), "ConditionExpression": condition,
        "ExpressionAttributeNames": names, "ExpressionAttributeValues": _values(values),
    }}


def _condition_check(pk, sk, condition, names, values):
    check = {"TableName": TABLE, "Key": _key(pk, sk), "ConditionExpression": condition,
             "ExpressionAttributeNames": names}
    if values:
        check["ExpressionAttributeValues"] = _values(values)
    return {"ConditionCheck": check}


def _key(pk, sk):
    return {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)}


def _values(values):
    return {k: serializer.serialize(v) for k, v in values.items()}


# --- Input ----------------------------------------------------------------------------

def _json_body(event):
    raw = event.get("body") or "{}"
    if len(raw) > MAX_BODY_BYTES:
        raise RequestError(400, "Request body is too large")
    try:
        body = json.loads(raw, parse_constant=_reject_constant)
    except (json.JSONDecodeError, ValueError, RecursionError):
        raise RequestError(400, "Invalid JSON in request body")
    if not isinstance(body, dict):
        raise RequestError(400, "Invalid JSON in request body")
    return body


def _reject_constant(name):
    raise ValueError(f"{name} is not allowed")


def _reject_fields(body, allowed):
    unsupported = sorted(set(body) - allowed)
    if unsupported:
        raise RequestError(400, f"Unsupported field(s): {', '.join(unsupported)}")


def _title(value):
    if not isinstance(value, str):
        raise RequestError(400, "title is required")
    title = value.strip()
    if not title:
        raise RequestError(400, "title is required")
    if len(title) > TITLE_MAX_LENGTH:
        raise RequestError(400, f"title must be at most {TITLE_MAX_LENGTH} characters")
    if CONTROL_CHARS.search(title):
        raise RequestError(400, "title contains invalid characters")
    return title


def _version(value, name):
    if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 12:
        value = int(value)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RequestError(400, f"{name} must be a non-negative integer")
    return value


def _id_list(value, name):
    if not isinstance(value, list) or len(value) > MAX_ENTRIES_PER_SECTION:
        raise RequestError(400, f"{name} must be a list of ids")
    ids = [_uuid(v, name) for v in value]
    if len(set(ids)) != len(ids):
        raise RequestError(400, f"{name} contains duplicates")
    return ids


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        raise RequestError(400, f"{name} is invalid")
    return value


def _display_name(claims):
    # Shown next to what each person wrote. From the ID token only, never
    # from the request body.
    for key in ("name", "email"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return CONTROL_CHARS.sub("", value.strip())[:NAME_MAX_LENGTH]
    return None


# --- Misc -----------------------------------------------------------------------------

def _uuid7():
    # Time-ordered UUID (RFC 9562 version 7), like the other records' ids.
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _utcnow():
    return datetime.now(timezone.utc)


def _now():
    return _utcnow().isoformat(timespec="microseconds")


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body),
    }
