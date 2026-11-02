"""Unit tests for re-notebook-api (the per-device RE Notebook), with DynamoDB
replaced by the in-memory fakes of test_cves_api, which evaluate condition
and update expressions and enforce DynamoDB's transaction rules.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import json
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

import test_cves_api as fakes

sys.path.insert(0, str(fakes.LAMBDAS / "re-notebook-api"))

USER, MEMBER, OTHER = fakes.USER, fakes.MEMBER, fakes.OTHER_USER
WS_A, WS_B = fakes.WS_A, fakes.WS_B
DEV_P = "11111111-1111-4111-8111-000000000001"  # personal device of USER
DEV_P2 = "11111111-1111-4111-8111-000000000002"  # another personal device of USER
DEV_O = "11111111-1111-4111-8111-000000000003"  # personal device of OTHER
DEV_A = "11111111-1111-4111-8111-0000000000a1"  # device of WS_A (USER owner, MEMBER member)
DEV_B = "11111111-1111-4111-8111-0000000000b1"  # device of WS_B (OTHER only)
MISSING = "11111111-1111-4111-8111-0000000000ff"
NOW = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)
NAMES = {USER: "Ipule", MEMBER: "member@example.org", OTHER: "Other"}

BASE = "/devices/{deviceId}/notebook"


def rows():
    return [
        *fakes.workspace_rows(WS_A, {USER: "owner", MEMBER: "member"}),
        *fakes.workspace_rows(WS_B, {OTHER: "owner"}),
        *fakes.personal_device_rows(DEV_P),
        *fakes.personal_device_rows(DEV_P2),
        *fakes.personal_device_rows(DEV_O, owner=OTHER),
        *fakes.workspace_device_rows(DEV_A, WS_A),
        *fakes.workspace_device_rows(DEV_B, WS_B),
    ]


def event(method, resource, user=USER, device=DEV_P, body=None, query=None, **path):
    claims = {"sub": user}
    if "@" in NAMES.get(user, ""):
        claims["email"] = NAMES[user]
    elif user in NAMES:
        claims["name"] = NAMES[user]
    return {
        "httpMethod": method,
        "resource": resource,
        "requestContext": {"authorizer": {"claims": claims}},
        "pathParameters": {"deviceId": device, **path},
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def item_key(item):
    (spec,) = item.values()
    key = spec.get("Key") or spec["Item"]  # a Put names its key in the item
    return key["pk"]["S"], key["sk"]["S"]


def paragraph_doc(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


class NotebookTestCase(unittest.TestCase):
    def setUp(self):
        self.module = fakes.load_lambda("re-notebook-api")
        self.table = fakes.FakeTable(rows())
        self.client = fakes.FakeClient(self.table)
        self.module.dynamodb = fakes.FakeResource(self.table)
        self.module.client = self.client
        patcher = mock.patch.object(self.module, "_utcnow", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    # --- calls ---
    def call(self, *args, **kwargs):
        resp = self.module.handler(event(*args, **kwargs), None)
        return resp["statusCode"], json.loads(resp["body"])

    def ok(self, expected_status, *args, **kwargs):
        status, body = self.call(*args, **kwargs)
        self.assertEqual(status, expected_status, body)
        return body

    def notebook(self, device=DEV_P, user=USER):
        return self.ok(200, "GET", BASE, user=user, device=device)["notebook"]

    def add_section(self, title="Physical Teardown", device=DEV_P, user=USER):
        return self.ok(201, "POST", BASE + "/sections", user=user, device=device, body={"title": title})

    def add_entry(self, section_id, title="Opening the device", device=DEV_P, user=USER):
        return self.ok(201, "POST", BASE + "/sections/{sectionId}/entries", user=user, device=device,
                       body={"title": title}, sectionId=section_id)

    def entry(self, entry_id, device=DEV_P, user=USER):
        return self.call("GET", BASE + "/entries/{entryId}", user=user, device=device, entryId=entry_id)

    def save(self, entry_id, doc, expected, device=DEV_P, user=USER):
        return self.call("PUT", BASE + "/entries/{entryId}/content", user=user, device=device,
                         body={"doc": doc, "expectedContentVersion": expected}, entryId=entry_id)

    def delete_entry(self, entry_id, version, content_version, device=DEV_P, user=USER):
        return self.call("DELETE", BASE + "/entries/{entryId}", user=user, device=device, entryId=entry_id,
                         query={"expectedVersion": str(version), "expectedContentVersion": str(content_version)})

    def setup_notebook(self, device=DEV_P, user=USER):
        """Two sections; the first with two entries, the second with one."""
        s1 = self.add_section("Physical Teardown", device, user)["sectionId"]
        s2 = self.add_section("Firmware Analysis", device, user)["sectionId"]
        e1 = self.add_entry(s1, "Opening the device", device, user)["entryId"]
        e2 = self.add_entry(s1, "Chipset identification", device, user)["entryId"]
        e3 = self.add_entry(s2, "Firmware extraction", device, user)["entryId"]
        return s1, s2, e1, e2, e3

    # --- table helpers ---
    def row(self, device, sk):
        return self.table.items.get((f"RENOTEBOOK#{device}", sk))

    def notebook_rows(self, device=DEV_P):
        return {sk: copy.deepcopy(v) for (pk, sk), v in self.table.items.items() if pk == f"RENOTEBOOK#{device}"}

    def structure(self, notebook):
        return [(s["title"], [e["title"] for e in s["entries"]]) for s in notebook["sections"]]


class StructureTests(NotebookTestCase):
    def test_empty_notebook_reads_without_writing(self):
        notebook = self.notebook()
        self.assertEqual(notebook["sections"], [])
        self.assertEqual(notebook["orderVersion"], 0)
        self.assertEqual(notebook["limits"]["sections"], 50)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.notebook_rows(), {})

    def test_sections_and_entries_in_order_with_authorship(self):
        self.setup_notebook()
        notebook = self.notebook()
        self.assertEqual(self.structure(notebook), [
            ("Physical Teardown", ["Opening the device", "Chipset identification"]),
            ("Firmware Analysis", ["Firmware extraction"]),
        ])
        entry = notebook["sections"][0]["entries"][0]
        self.assertEqual((entry["createdBy"], entry["createdByName"], entry["createdAt"]),
                         (USER, "Ipule", NOW.isoformat(timespec="microseconds")))
        self.assertEqual((entry["version"], entry["contentVersion"]), (1, 1))
        self.assertNotIn("doc", entry)

    def test_rows_and_keys(self):
        s1, _, e1, _, _ = self.setup_notebook()
        rows = self.notebook_rows()
        self.assertEqual(rows["METADATA"]["entity"], "re-notebook")
        self.assertEqual(rows[f"SECTION#{s1}"]["entity"], "re-notebook-section")
        self.assertEqual(rows[f"ENTRY#{e1}"]["entity"], "re-notebook-entry")
        self.assertEqual(rows[f"CONTENT#{e1}"]["entity"], "re-notebook-content")
        self.assertNotIn("doc", rows[f"ENTRY#{e1}"])
        self.assertEqual(json.loads(rows[f"CONTENT#{e1}"]["doc"]), {"type": "doc", "content": [{"type": "paragraph"}]})
        # Scope lives only on the device: nothing in the notebook copies it.
        self.assertFalse(any("workspaceId" in row for row in rows.values()))

    def test_every_write_rechecks_device_scope_and_access(self):
        self.setup_notebook()
        for items in self.client.calls:
            keys = [item_key(item) for item in items]
            self.assertIn((f"DEVICE#{DEV_P}", "METADATA"), keys)
            self.assertIn((f"USER#{USER}", f"DEVICE#{DEV_P}"), keys)

    def test_title_validation(self):
        for title, message in ((None, "title is required"), ("   ", "title is required"),
                               ("x" * 201, "at most 200"), ("a\nb", "invalid characters"), (5, "required")):
            with self.subTest(title=title):
                status, body = self.call("POST", BASE + "/sections", body={"title": title})
                self.assertEqual(status, 400)
                self.assertIn(message, body["error"])
        self.assertEqual(self.notebook_rows(), {})

    def test_titles_are_trimmed(self):
        sid = self.add_section("  Teardown  ")["sectionId"]
        self.assertEqual(self.row(DEV_P, f"SECTION#{sid}")["title"], "Teardown")

    def test_bad_requests(self):
        self.assertEqual(self.call("GET", "/devices/{deviceId}/elsewhere")[0], 404)
        self.assertEqual(self.call("GET", BASE, device="not-a-uuid")[0], 400)
        self.assertEqual(self.call("GET", BASE + "/entries/{entryId}", entryId="x")[0], 400)
        self.assertEqual(self.call("POST", BASE + "/sections", body="{bad")[0], 400)
        self.assertEqual(self.call("POST", BASE + "/sections", body=[1])[0], 400)
        self.assertEqual(self.call("POST", BASE + "/sections", body='{"title": NaN}')[0], 400)
        status, body = self.call("POST", BASE + "/sections", body={"title": "x", "workspaceId": WS_A})
        self.assertEqual((status, body["error"]), (400, "Unsupported field(s): workspaceId"))
        no_claims = event("GET", BASE)
        no_claims["requestContext"] = {}
        self.assertEqual(self.module.handler(no_claims, None)["statusCode"], 401)

    def test_deeply_nested_json_body_is_refused(self):
        body = '{"doc": ' + "[" * 5000 + "]" * 5000 + ', "expectedContentVersion": 1}'
        sid = self.add_section()["sectionId"]
        eid = self.add_entry(sid)["entryId"]
        status, _ = self.call("PUT", BASE + "/entries/{entryId}/content", body=body, entryId=eid)
        self.assertEqual(status, 400)


class AuthorizationTests(NotebookTestCase):
    def test_personal_device_is_owner_only(self):
        s1, _, e1, _, _ = self.setup_notebook()
        for user in (MEMBER, OTHER):
            with self.subTest(user=user):
                self.assertEqual(self.call("GET", BASE, user=user)[0], 404)
                self.assertEqual(self.entry(e1, user=user)[0], 404)
                self.assertEqual(self.call("POST", BASE + "/sections", user=user, body={"title": "x"})[0], 404)
                self.assertEqual(self.save(e1, paragraph_doc("x"), 1, user=user)[0], 404)
        self.assertEqual(len(self.notebook()["sections"]), 2)

    def test_missing_device_is_404(self):
        status, body = self.call("GET", BASE, device=MISSING)
        self.assertEqual((status, body["error"]), (404, "Device not found"))

    def test_workspace_members_read_and_contribute(self):
        s1 = self.add_section(device=DEV_A, user=USER)["sectionId"]
        eid = self.add_entry(s1, device=DEV_A, user=MEMBER)["entryId"]
        status, body = self.save(eid, paragraph_doc("member notes"), 1, device=DEV_A, user=MEMBER)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["entry"]["contentUpdatedByName"], "member@example.org")
        status, body = self.entry(eid, device=DEV_A, user=USER)
        self.assertEqual(body["doc"], paragraph_doc("member notes"))
        keys = [item_key(i) for i in self.client.calls[-1]]
        self.assertIn((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"), keys)

    def test_non_members_get_404(self):
        self.add_section(device=DEV_A)
        self.assertEqual(self.call("GET", BASE, user=OTHER, device=DEV_A)[0], 404)
        self.assertEqual(self.call("GET", BASE, user=USER, device=DEV_B)[0], 404)

    def test_leftover_owner_row_on_workspace_device_grants_nothing(self):
        self.table.items[(f"USER#{OTHER}", f"DEVICE#{DEV_A}")] = {
            "pk": f"USER#{OTHER}", "sk": f"DEVICE#{DEV_A}", "entity": "user-device", "role": "owner"}
        self.assertEqual(self.call("GET", BASE, user=OTHER, device=DEV_A)[0], 404)

    def test_entries_of_another_device_are_not_reachable(self):
        _, _, e1, _, _ = self.setup_notebook(device=DEV_P)
        s_other = self.add_section(device=DEV_P2)["sectionId"]
        # Same user, other device: the keys are built from the authorized
        # device, so the entry id names nothing there.
        self.assertEqual(self.entry(e1, device=DEV_P2)[0], 404)
        self.assertEqual(self.save(e1, paragraph_doc("x"), 1, device=DEV_P2)[0], 404)
        status, _ = self.call("POST", BASE + "/entries/{entryId}/move", device=DEV_P2, entryId=e1,
                              body={"targetSectionId": s_other, "expectedVersion": 1})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(self.row(DEV_P, f"CONTENT#{e1}")["doc"])["content"], [{"type": "paragraph"}])

    def test_membership_removed_during_the_request_writes_nothing(self):
        sid = self.add_section(device=DEV_A, user=MEMBER)["sectionId"]
        before = self.notebook_rows(DEV_A)

        def remove_member(table):
            table.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"), None)

        self.client.before_transact = remove_member
        status, _ = self.call("POST", BASE + "/sections/{sectionId}/entries", user=MEMBER, device=DEV_A,
                              body={"title": "x"}, sectionId=sid)
        self.assertEqual(status, 404)
        self.assertEqual(self.notebook_rows(DEV_A), before)

    def test_device_scope_change_during_the_request_writes_nothing(self):
        sid = self.add_section()["sectionId"]
        eid = self.add_entry(sid)["entryId"]
        before = self.notebook_rows()

        def move_to_workspace(table):
            table.items[(f"DEVICE#{DEV_P}", "METADATA")]["workspaceId"] = WS_A

        self.client.before_transact = move_to_workspace
        self.assertEqual(self.save(eid, paragraph_doc("x"), 1)[0], 404)
        self.assertEqual(self.notebook_rows(), before)

    def test_transaction_conflict_is_409_busy(self):
        sid = self.add_section()["sectionId"]
        self.client.fail_code = "TransactionConflict"
        status, body = self.call("PATCH", BASE + "/sections/{sectionId}", sectionId=sid,
                                 body={"title": "x", "expectedVersion": 1})
        self.assertEqual((status, body["code"]), (409, "busy"))


class SectionTests(NotebookTestCase):
    def rename(self, sid, title, version):
        return self.call("PATCH", BASE + "/sections/{sectionId}", sectionId=sid,
                         body={"title": title, "expectedVersion": version})

    def delete(self, sid, version):
        return self.call("DELETE", BASE + "/sections/{sectionId}", sectionId=sid,
                         query={"expectedVersion": str(version)})

    def test_rename_is_versioned(self):
        sid = self.add_section()["sectionId"]
        status, body = self.rename(sid, "Teardown", 1)
        self.assertEqual(status, 200)
        self.assertEqual(body["notebook"]["sections"][0]["title"], "Teardown")
        self.assertEqual(body["notebook"]["sections"][0]["version"], 2)
        status, body = self.rename(sid, "Stale", 1)
        self.assertEqual((status, body["code"], body["section"]["title"]), (409, "conflict", "Teardown"))
        self.assertEqual(self.rename(fakes.MISSING, "x", 1)[0], 404)

    def test_limit(self):
        for i in range(self.module.MAX_SECTIONS):
            self.add_section(f"S{i}")
        status, body = self.call("POST", BASE + "/sections", body={"title": "one too many"})
        self.assertEqual((status, body["code"]), (409, "limit"))
        self.assertEqual(len(self.notebook()["sections"]), self.module.MAX_SECTIONS)

    def test_only_empty_sections_can_be_deleted(self):
        s1, s2, e1, e2, e3 = self.setup_notebook()
        status, body = self.delete(s2, 1)
        self.assertEqual((status, body["code"]), (409, "not_empty"))
        self.assertEqual(self.delete_entry(e3, 1, 1)[0], 200)
        self.assertEqual(self.delete(s2, 2)[0], 409)  # stale version
        status, body = self.delete(s2, 1)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.structure(body["notebook"]),
                         [("Physical Teardown", ["Opening the device", "Chipset identification"])])
        self.assertIsNone(self.row(DEV_P, f"SECTION#{s2}"))
        # The soft-deleted entry and its document are kept.
        self.assertIn("deletedAt", self.row(DEV_P, f"ENTRY#{e3}"))
        self.assertIsNotNone(self.row(DEV_P, f"CONTENT#{e3}"))
        self.assertEqual(self.delete(s2, 1)[0], 404)

    def test_an_entry_added_meanwhile_stops_the_delete(self):
        sid = self.add_section()["sectionId"]

        def add_entry_meanwhile(table):
            table.items[(f"RENOTEBOOK#{DEV_P}", f"SECTION#{sid}")]["entryIds"] = ["x"]

        self.client.before_transact = add_entry_meanwhile
        status, body = self.delete(sid, 1)
        self.assertEqual((status, body["code"]), (409, "not_empty"))
        self.assertIsNotNone(self.row(DEV_P, f"SECTION#{sid}"))

    def test_reorder(self):
        s1, s2, *_ = self.setup_notebook()
        version = self.notebook()["orderVersion"]
        status, body = self.call("PUT", BASE + "/section-order",
                                 body={"sectionIds": [s2, s1], "expectedOrderVersion": version})
        self.assertEqual(status, 200, body)
        self.assertEqual([s["sectionId"] for s in body["notebook"]["sections"]], [s2, s1])

    def test_stale_or_incomplete_reorder_is_refused(self):
        s1, s2, *_ = self.setup_notebook()
        version = self.notebook()["orderVersion"]
        for ids, v in (([s2, s1], version - 1), ([s2], version), ([s2, s1, fakes.MISSING], version)):
            with self.subTest(ids=ids, version=v):
                status, body = self.call("PUT", BASE + "/section-order",
                                         body={"sectionIds": ids, "expectedOrderVersion": v})
                self.assertEqual((status, body["code"]), (409, "stale_order"))
                self.assertEqual([s["sectionId"] for s in body["notebook"]["sections"]], [s1, s2])
        status, _ = self.call("PUT", BASE + "/section-order",
                              body={"sectionIds": [s1, s1], "expectedOrderVersion": version})
        self.assertEqual(status, 400)

    def test_concurrent_section_creation_is_retried(self):
        self.add_section("First")
        calls = {"n": 0}

        def someone_else_adds_one(table):
            calls["n"] += 1
            if calls["n"] == 1:
                meta = table.items[(f"RENOTEBOOK#{DEV_P}", "METADATA")]
                meta["sectionIds"] = meta["sectionIds"] + ["0192d000-0000-7000-8000-000000000001"]
                meta["orderVersion"] += 1

        self.client.before_transact = someone_else_adds_one
        sid = self.add_section("Second")["sectionId"]
        ids = self.row(DEV_P, "METADATA")["sectionIds"]
        self.assertEqual(ids[-1], sid)
        self.assertEqual(len(ids), 3)


class EntryTests(NotebookTestCase):
    def test_create_and_read(self):
        sid = self.add_section()["sectionId"]
        body = self.add_entry(sid, "Opening the device")
        status, entry = self.entry(body["entryId"])
        self.assertEqual(status, 200)
        self.assertEqual(entry["entry"]["title"], "Opening the device")
        self.assertEqual(entry["doc"], {"type": "doc", "content": [{"type": "paragraph"}]})
        self.assertEqual(entry["schemaVersion"], 1)
        status, _ = self.call("POST", BASE + "/sections/{sectionId}/entries", sectionId=fakes.MISSING,
                              body={"title": "x"})
        self.assertEqual(status, 404)

    def test_entry_limit(self):
        sid = self.add_section()["sectionId"]
        section = self.table.items[(f"RENOTEBOOK#{DEV_P}", f"SECTION#{sid}")]
        section["entryIds"] = [f"0192d000-0000-7000-8000-{i:012d}" for i in range(200)]
        status, body = self.call("POST", BASE + "/sections/{sectionId}/entries", sectionId=sid, body={"title": "x"})
        self.assertEqual((status, body["code"]), (409, "limit"))

    def test_rename_is_versioned(self):
        s1, _, e1, *_ = self.setup_notebook()
        status, body = self.call("PATCH", BASE + "/entries/{entryId}", entryId=e1,
                                 body={"title": "Opening the case", "expectedVersion": 1})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["entry"]["title"], body["entry"]["version"]), ("Opening the case", 2))
        status, body = self.call("PATCH", BASE + "/entries/{entryId}", entryId=e1,
                                 body={"title": "Stale", "expectedVersion": 1})
        self.assertEqual((status, body["code"], body["entry"]["title"]), (409, "conflict", "Opening the case"))

    def test_reorder_entries(self):
        s1, _, e1, e2, _ = self.setup_notebook()
        version = self.notebook()["sections"][0]["orderVersion"]
        status, body = self.call("PUT", BASE + "/sections/{sectionId}/entry-order", sectionId=s1,
                                 body={"entryIds": [e2, e1], "expectedOrderVersion": version})
        self.assertEqual(status, 200, body)
        self.assertEqual([e["entryId"] for e in body["notebook"]["sections"][0]["entries"]], [e2, e1])
        status, body = self.call("PUT", BASE + "/sections/{sectionId}/entry-order", sectionId=s1,
                                 body={"entryIds": [e1, e2], "expectedOrderVersion": version})
        self.assertEqual((status, body["code"]), (409, "stale_order"))

    def test_concurrent_entry_creation_keeps_both(self):
        sid = self.add_section()["sectionId"]
        first = self.add_entry(sid, "First")["entryId"]
        calls = {"n": 0}

        def someone_else_adds_one(table):
            calls["n"] += 1
            if calls["n"] == 1:
                # Another request adds an entry between this one's read and write.
                self.client.before_transact = None
                self.add_entry(sid, "Concurrent")
                self.client.before_transact = someone_else_adds_one

        self.client.before_transact = someone_else_adds_one
        self.add_entry(sid, "Second")
        self.client.before_transact = None
        titles = self.structure(self.notebook())[0][1]
        self.assertEqual(sorted(titles), ["Concurrent", "First", "Second"])
        self.assertEqual(self.row(DEV_P, f"SECTION#{sid}")["entryIds"][0], first)


class ContentTests(NotebookTestCase):
    def setUp(self):
        super().setUp()
        self.sid = self.add_section()["sectionId"]
        self.eid = self.add_entry(self.sid)["entryId"]

    def test_save_bumps_the_content_version(self):
        status, body = self.save(self.eid, paragraph_doc("Removed four screws"), 1)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["entry"]["contentVersion"], 2)
        self.assertEqual(body["entry"]["textLength"], len("Removed four screws"))
        self.assertEqual(body["entry"]["version"], 1)  # title/placement unchanged
        status, entry = self.entry(self.eid)
        self.assertEqual(entry["doc"], paragraph_doc("Removed four screws"))
        self.assertEqual(self.row(DEV_P, f"CONTENT#{self.eid}")["contentVersion"], 2)

    def test_conflict_returns_their_version_and_writes_nothing(self):
        self.assertEqual(self.save(self.eid, paragraph_doc("theirs"), 1, user=USER)[0], 200)
        before = self.notebook_rows()
        status, body = self.save(self.eid, paragraph_doc("mine"), 1)
        self.assertEqual((status, body["code"]), (409, "conflict"))
        self.assertEqual(body["doc"], paragraph_doc("theirs"))
        self.assertEqual(body["entry"]["contentVersion"], 2)
        self.assertEqual(self.notebook_rows(), before)

    def test_invalid_documents_are_refused(self):
        for doc in ("<p>x</p>", {"type": "doc", "content": [{"type": "image"}]}, None):
            with self.subTest(doc=doc):
                status, body = self.save(self.eid, doc, 1)
                self.assertEqual((status, body["code"]), (400, "invalid_document"))
        self.assertEqual(self.row(DEV_P, f"CONTENT#{self.eid}")["contentVersion"], 1)

    def test_versions_must_be_non_negative_integers(self):
        for version in (-1, "1.5", True, None, "abc"):
            with self.subTest(version=version):
                self.assertEqual(self.save(self.eid, paragraph_doc("x"), version)[0], 400)

    def test_rename_does_not_conflict_with_saving(self):
        self.call("PATCH", BASE + "/entries/{entryId}", entryId=self.eid, body={"title": "New", "expectedVersion": 1})
        self.assertEqual(self.save(self.eid, paragraph_doc("still saves"), 1)[0], 200)


class MoveTests(NotebookTestCase):
    def move(self, entry_id, target, version, position=None):
        body = {"targetSectionId": target, "expectedVersion": version}
        if position is not None:
            body["position"] = position
        return self.call("POST", BASE + "/entries/{entryId}/move", entryId=entry_id, body=body)

    def test_move_between_sections(self):
        s1, s2, e1, e2, e3 = self.setup_notebook()
        status, body = self.move(e1, s2, 1, position=0)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.structure(body["notebook"]), [
            ("Physical Teardown", ["Chipset identification"]),
            ("Firmware Analysis", ["Opening the device", "Firmware extraction"]),
        ])
        self.assertEqual((body["entry"]["sectionId"], body["entry"]["version"]), (s2, 2))
        # Content is untouched by a move.
        self.assertEqual(self.row(DEV_P, f"CONTENT#{e1}")["contentVersion"], 1)

    def test_default_position_is_the_end(self):
        s1, s2, e1, e2, e3 = self.setup_notebook()
        body = self.move(e1, s2, 1)[1]
        self.assertEqual(self.structure(body["notebook"])[1][1], ["Firmware extraction", "Opening the device"])

    def test_refusals(self):
        s1, s2, e1, e2, e3 = self.setup_notebook()
        status, body = self.move(e1, s2, 5)
        self.assertEqual((status, body["code"]), (409, "conflict"))
        self.assertEqual(self.move(e1, s1, 1)[0], 400)
        self.assertEqual(self.move(e1, fakes.MISSING, 1)[0], 404)
        self.assertEqual(self.move(e1, s2, 1, position=-1)[0], 400)
        target = self.table.items[(f"RENOTEBOOK#{DEV_P}", f"SECTION#{s2}")]
        target["entryIds"] = [f"0192d000-0000-7000-8000-{i:012d}" for i in range(200)]
        self.assertEqual(self.move(e1, s2, 1)[1]["code"], "limit")
        self.assertEqual(self.row(DEV_P, f"ENTRY#{e1}")["sectionId"], s1)


class SoftDeleteTests(NotebookTestCase):
    def setUp(self):
        super().setUp()
        self.s1, self.s2, self.e1, self.e2, self.e3 = self.setup_notebook()
        self.assertEqual(self.save(self.e1, paragraph_doc("keep me"), 1)[0], 200)

    def test_delete_hides_the_entry_but_keeps_its_rows(self):
        status, body = self.delete_entry(self.e1, 1, 2)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.structure(body["notebook"])[0][1], ["Chipset identification"])
        entry = self.row(DEV_P, f"ENTRY#{self.e1}")
        self.assertEqual((entry["deletedBy"], entry["deletedByName"], entry["sectionId"]), (USER, "Ipule", self.s1))
        self.assertEqual(json.loads(self.row(DEV_P, f"CONTENT#{self.e1}")["doc"]), paragraph_doc("keep me"))
        status, body = self.entry(self.e1)
        self.assertEqual((status, body["code"], body["deletedByName"]), (404, "deleted", "Ipule"))

    def test_delete_is_versioned(self):
        status, body = self.delete_entry(self.e1, 1, 1)  # didn't see the latest save
        self.assertEqual((status, body["code"]), (409, "conflict"))
        self.assertNotIn("deletedAt", self.row(DEV_P, f"ENTRY#{self.e1}"))

    def test_stale_requests_cannot_edit_or_restore_a_deleted_entry(self):
        self.assertEqual(self.delete_entry(self.e1, 1, 2)[0], 200)
        before = self.notebook_rows()
        self.assertEqual(self.save(self.e1, paragraph_doc("late autosave"), 2)[1]["code"], "deleted")
        status, body = self.call("PATCH", BASE + "/entries/{entryId}", entryId=self.e1,
                                 body={"title": "x", "expectedVersion": 1})
        self.assertEqual((status, body["code"]), (404, "deleted"))
        status, _ = self.call("POST", BASE + "/entries/{entryId}/move", entryId=self.e1,
                              body={"targetSectionId": self.s2, "expectedVersion": 2})
        self.assertEqual(status, 404)
        self.assertEqual(self.delete_entry(self.e1, 2, 2)[0], 404)
        # A stale order that still lists the entry can't put it back either.
        version = self.notebook()["sections"][0]["orderVersion"]
        status, _ = self.call("PUT", BASE + "/sections/{sectionId}/entry-order", sectionId=self.s1,
                              body={"entryIds": [self.e1, self.e2], "expectedOrderVersion": version})
        self.assertEqual(status, 409)
        self.assertEqual(self.notebook_rows(), before)

    def test_delete_racing_a_save_writes_only_one(self):
        def save_meanwhile(table):
            self.client.before_transact = None
            self.assertEqual(self.save(self.e1, paragraph_doc("saved first"), 2)[0], 200)

        self.client.before_transact = save_meanwhile
        status, body = self.delete_entry(self.e1, 1, 2)
        self.assertEqual((status, body["code"]), (409, "conflict"))
        self.assertNotIn("deletedAt", self.row(DEV_P, f"ENTRY#{self.e1}"))


if __name__ == "__main__":
    unittest.main()
