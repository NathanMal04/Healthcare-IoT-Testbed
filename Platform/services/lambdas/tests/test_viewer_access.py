"""The read-only workspace viewer role, across every workspace-scoped Lambda.

A viewer (USER#{uid} / WORKSPACE#{wid} with role "viewer") may read and
download everything in that one workspace and change nothing. Each write is
called directly, as a hand-crafted API request would be, and must be refused
without touching the table, S3, Batch or the transaction client; the same
request from a member succeeds where that's cheap to show, so the refusal is
the role and not a malformed request. RouteInventoryTests keeps the matrix
complete: a new API route fails it until it's classified here.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_cves_api as cves  # noqa: E402
import test_image_replacement as replacement  # noqa: E402
import test_re_notebook_api as notebook  # noqa: E402
import test_sessions as sessions  # noqa: E402
import test_workspace_artifacts as wa  # noqa: E402
import test_workspace_runs as runs  # noqa: E402
from test_workspace_artifacts import D1, D3, DP, MEMBER, USER, W1, W2, event, response_body  # noqa: E402

VIEWER = "user-professor"
REFUSED = (403, 404)


def snapshot(table):
    return copy.deepcopy(table.items)


# --- Route inventory ---------------------------------------------------------------

INFRA = Path(__file__).resolve().parents[3] / "infra" / "envs" / "dev"

# What a viewer may do with each authenticated route of the main API.
#   read      allowed (in a workspace they view)
#   write     refused for viewers (contributors only)
#   owner     workspace administration, owners only
#   own       the caller's own invitations / personal resources; not workspace-scoped
VIEWER_MATRIX = {
    # workspaces-api
    "GET workspaces": "read", "POST workspaces": "own", "GET workspaces/*": "read",
    "POST workspaces/*/invites": "owner", "POST workspaces/*/invites/revoke": "owner",
    "DELETE workspaces/*/members/*": "owner",
    "POST workspaces/*/accept": "own", "POST workspaces/*/decline": "own", "GET invites": "own",
    # devices (main.tf)
    "GET devices": "read", "POST devices": "write", "GET devices/*": "read", "PATCH devices/*": "write",
    # legacy firmware routes: personal devices only, workspace devices refused for everyone
    "GET devices/*/firmware": "own", "POST devices/*/firmware/presign": "own",
    "POST devices/*/firmware/*/complete": "own",
    # artifacts
    "GET artifacts": "read", "GET artifacts/batches": "read", "GET artifacts/*": "read",
    "GET artifacts/*/download": "read", "POST artifacts/view-urls": "read", "GET devices/*/artifacts": "read",
    "POST artifacts/presign": "write", "POST artifacts/complete": "write", "POST artifacts/*/parts": "write",
    "POST artifacts/*/retry": "write", "POST artifacts/*/replacement": "write",
    "POST artifacts/*/replacement/complete": "write", "PATCH artifacts/*": "write",
    # cves
    "GET cves": "read", "GET cves/*": "read", "POST cves": "write", "PATCH cves/*": "write",
    "DELETE cves/*": "write", "PUT cves/*/devices/*": "write", "DELETE cves/*/devices/*": "write",
    # RE notebook
    "GET devices/*/notebook": "read", "GET devices/*/notebook/entries/*": "read",
    "POST devices/*/notebook/sections": "write", "PATCH devices/*/notebook/sections/*": "write",
    "DELETE devices/*/notebook/sections/*": "write", "PUT devices/*/notebook/section-order": "write",
    "POST devices/*/notebook/sections/*/entries": "write", "PUT devices/*/notebook/sections/*/entry-order": "write",
    "PATCH devices/*/notebook/entries/*": "write", "DELETE devices/*/notebook/entries/*": "write",
    "PUT devices/*/notebook/entries/*/content": "write", "POST devices/*/notebook/entries/*/move": "write",
    # runs
    "GET runs": "read", "GET runs/*": "read", "GET runs/*/children/*/log": "read",
    "POST runs": "write", "POST runs/estimate": "write", "POST runs/*/cancel": "write",
    # sessions are personal; starting one over workspace files is a write
    "GET sessions": "own", "POST sessions": "write", "GET sessions/*": "own",
    "POST sessions/*/stop": "own", "GET sessions/*/log": "own",
    # scripts, environments and usage are personal
    "GET modules": "own", "POST modules": "own", "GET modules/*": "own", "POST modules/*/versions": "own",
    "POST modules/*/versions/*/complete": "own", "GET modules/*/versions/*/download": "own",
    "GET modules/*/versions/*/log": "own", "GET modules/*/versions/*/packages": "own",
    "GET environments": "own", "POST environments": "own", "GET environments/catalog": "own",
    "GET environments/*": "own", "POST environments/*/versions": "own",
    "GET environments/*/versions/*/log": "own", "GET environments/*/versions/*/packages": "own",
    "GET usage": "own",
}

# Routes whose method and path aren't in a route map (main.tf's hand-written
# device and firmware methods, usage.tf's single module).
HAND_WRITTEN = {"GET devices", "POST devices", "GET devices/*/firmware", "POST devices/*/firmware/presign",
                "POST devices/*/firmware/*/complete", "GET usage"}


def terraform_routes():
    routes = set()
    for tf in INFRA.glob("*.tf"):
        text = tf.read_text()
        for method, path in re.findall(r'method\s*=\s*"([A-Z]+)"\s*,?\s*path\s*=\s*"([^"]+)"', text):
            routes.add(f"{method} {path}")
        for method, path in re.findall(r'http_method\s*=\s*"([A-Z]+)"\s*route_path\s*=\s*"([^"]+)"', text):
            routes.add(f"{method} {path}")
    return routes


class RouteInventoryTests(unittest.TestCase):
    def test_every_route_is_classified(self):
        routes = terraform_routes() | HAND_WRITTEN
        self.assertGreater(len(routes), 60)
        self.assertEqual(sorted(routes - set(VIEWER_MATRIX)), [], "classify new routes in VIEWER_MATRIX")
        self.assertEqual(sorted(set(VIEWER_MATRIX) - routes), [], "VIEWER_MATRIX names a route that's gone")


# --- Shared layer -------------------------------------------------------------------

class SharedLayerTests(unittest.TestCase):
    def test_role_sets(self):
        import testbed_authz
        self.assertEqual(testbed_authz.CONTRIBUTOR_ROLES, ("owner", "member"))
        self.assertEqual(testbed_authz.MEMBERSHIP_ROLES, ("owner", "member", "viewer"))
        # The defaults (and the in-transaction role checks built from
        # WORKSPACE_ROLES) stay write-only.
        self.assertEqual(testbed_authz.WORKSPACE_ROLES, testbed_authz.CONTRIBUTOR_ROLES)


# --- Devices and artifacts ----------------------------------------------------------

class ViewerWorld(wa.WorldTestCase):
    def setUp(self):
        super().setUp()
        wa.add_rows(self.table, wa.membership(VIEWER, W1, "viewer"))
        self.f1 = self.upload(USER, [D1])                       # ready firmware in W1
        self.f3 = self.upload(wa.W2_OWNER, [D3])                # ready firmware in W2
        self.pending = self.upload(USER, [D1], ready=False, artifact_type="binary",
                                   size=100 * 1024 ** 2)        # multipart, still pending
        self.batch = self.table.items[(f"ARTIFACT#{self.f1}", "METADATA")]["uploadBatchId"]

    def call(self, name, user, resource, method=None, **kwargs):
        e = event(user, resource, **kwargs)
        if method:
            e["httpMethod"] = method
        resp = self.lam(name).handler(e, None)
        return resp["statusCode"], json.loads(resp["body"])

    def assert_refused_without_side_effects(self, name, resource, method=None, **kwargs):
        module = self.lam(name)
        if hasattr(module, "s3"):
            module.s3.reset_mock()
        before, calls = snapshot(self.table), len(self.client.calls)
        status, body = self.call(name, VIEWER, resource, method, **kwargs)
        self.assertIn(status, REFUSED, body)
        self.assertEqual(self.table.items, before)
        self.assertEqual(len(self.client.calls), calls)
        for attr in ("generate_presigned_post", "create_multipart_upload", "upload_part", "delete_object"):
            if hasattr(module, "s3"):
                getattr(module.s3, attr).assert_not_called()
        return status


class ViewerDeviceTests(ViewerWorld):
    def test_lists_and_reads_workspace_devices(self):
        status, body = self.call("list-devices", VIEWER, None, query={"workspaceId": W1})
        self.assertEqual(status, 200, body)
        self.assertEqual({d["deviceId"] for d in body["devices"]}, {D1, wa.D2})
        self.assertEqual({d["role"] for d in body["devices"]}, {"viewer"})

        status, body = self.call("list-devices", VIEWER, "/devices/{deviceId}", path={"deviceId": D1})
        self.assertEqual(status, 200, body)
        self.assertEqual(body.get("role") or body.get("device", {}).get("role"), "viewer")

    def test_cannot_create_or_update_devices(self):
        self.assert_refused_without_side_effects(
            "create-device", "/devices", body={"name": "X", "type": "pump", "workspaceId": W1})
        for body in ({"name": "Renamed"}, {"reverseEngineeringStatus": "complete"},
                     {"profileImageArtifactId": None}, {"notes": "x"}):
            with self.subTest(body=body):
                self.assert_refused_without_side_effects(
                    "update-device", "/devices/{deviceId}", body=body, path={"deviceId": D1})
        # The member control: the same create succeeds.
        status, _ = self.call("create-device", MEMBER, "/devices",
                              body={"name": "X", "type": "pump", "workspaceId": W1})
        self.assertEqual(status, 201)

    def test_transaction_rejects_viewer_even_if_precheck_is_bypassed(self):
        # A pre-check that wrongly let the viewer through: the membership
        # ConditionCheck inside the transaction still refuses the write.
        module = self.lam("create-device")
        before = snapshot(self.table)
        with mock.patch.object(module.testbed_authz, "require_member", return_value="member"):
            status, _ = self.call("create-device", VIEWER, "/devices",
                                  body={"name": "X", "type": "pump", "workspaceId": W1})
        self.assertEqual(status, 404)
        self.assertEqual(self.table.items, before)

    def test_no_access_to_other_workspaces(self):
        status, _ = self.call("list-devices", VIEWER, None, query={"workspaceId": W2})
        self.assertEqual(status, 404)
        status, _ = self.call("list-devices", VIEWER, "/devices/{deviceId}", path={"deviceId": D3})
        self.assertEqual(status, 403)
        status, _ = self.call("list-devices", VIEWER, "/devices/{deviceId}", path={"deviceId": DP})
        self.assertEqual(status, 403)
        # Their own (empty) personal list is unaffected.
        status, body = self.call("list-devices", VIEWER, None)
        self.assertEqual((status, body["devices"]), (200, []))


class ViewerArtifactTests(ViewerWorld):
    def test_reads_lists_and_downloads(self):
        status, body = self.call("artifacts-get", VIEWER, "/artifacts/{artifactId}", path={"artifactId": self.f1})
        self.assertEqual((status, body["artifact"]["workspaceId"]), (200, W1))
        status, body = self.call("artifacts-get", VIEWER, "/artifacts/{artifactId}/download",
                                 path={"artifactId": self.f1})
        self.assertEqual((status, body["url"]), (200, "https://download"))

        listings = [
            dict(resource=None, query={"workspaceId": W1}),
            dict(resource=None, query={"batchId": self.batch}),
            dict(resource="/devices/{deviceId}/artifacts", path={"deviceId": D1}),
            dict(resource="/artifacts/batches", query={"workspaceId": W1}),
        ]
        for kwargs in listings:
            with self.subTest(**kwargs):
                status, body = self.call("artifacts-list", VIEWER, kwargs.pop("resource"), **kwargs)
                self.assertEqual(status, 200, body)
        status, body = self.call("artifacts-list", VIEWER, None, query={"workspaceId": W1})
        self.assertIn(self.f1, [a["artifactId"] for a in body["artifacts"]])

    def test_cannot_read_other_workspaces_or_personal(self):
        for resource in ("/artifacts/{artifactId}", "/artifacts/{artifactId}/download"):
            status, _ = self.call("artifacts-get", VIEWER, resource, path={"artifactId": self.f3})
            self.assertEqual(status, 404)
        status, _ = self.call("artifacts-list", VIEWER, None, query={"workspaceId": W2})
        self.assertEqual(status, 404)
        status, _ = self.call("artifacts-list", VIEWER, "/devices/{deviceId}/artifacts", path={"deviceId": D3})
        self.assertEqual(status, 403)
        status, _ = self.call("artifacts-list", VIEWER, "/artifacts/batches", query={"workspaceId": W2})
        self.assertEqual(status, 404)

    def test_cannot_upload_or_change_artifacts(self):
        attempt = self.table.items[(f"ARTIFACT#{self.pending}", "METADATA")]["attemptId"]
        # Uploading to a workspace device, or into the workspace's batch.
        self.assert_refused_without_side_effects(
            "artifacts-presign", "/artifacts/presign", body={"files": [self.file()], "deviceIds": [D1]})
        self.assert_refused_without_side_effects(
            "artifacts-presign", "/artifacts/presign",
            body={"files": [self.file()], "deviceIds": [D1], "uploadBatchId": self.batch})
        for resource, body in (("/artifacts/{artifactId}/parts", {"attemptId": attempt, "parts": [
                                    {"partNumber": 1, "sha256": wa.SHA}]}),
                               ("/artifacts/{artifactId}/retry", {"attemptId": attempt}),
                               ("/artifacts/{artifactId}/replacement", {})):
            with self.subTest(resource=resource):
                self.assert_refused_without_side_effects(
                    "artifacts-presign", resource, body=body, path={"artifactId": self.pending})
        self.assert_refused_without_side_effects(
            "artifacts-update", "/artifacts/{artifactId}", body={"reverseEngineeringStatus": "complete"},
            path={"artifactId": self.f1})
        self.assert_refused_without_side_effects(
            "artifacts-complete", "/artifacts/{artifactId}/replacement/complete",
            body={"replacementId": "0192a000-0000-7000-8000-00000000abcd"}, path={"artifactId": self.f1})

        # artifacts/complete answers 200 with a per-item 404.
        before = snapshot(self.table)
        status, body = self.call("artifacts-complete", VIEWER, None,
                                 body={"items": [{"artifactId": self.pending, "attemptId": attempt}]})
        self.assertEqual((status, body["results"][0]["ok"], body["results"][0]["status"]), (200, False, 404))
        self.assertEqual(self.table.items, before)

        # Member controls.
        status, _ = self.call("artifacts-update", MEMBER, "/artifacts/{artifactId}",
                              body={"reverseEngineeringStatus": "complete"}, path={"artifactId": self.f1})
        self.assertEqual(status, 200)
        status, _ = self.call("artifacts-presign", MEMBER, "/artifacts/{artifactId}/parts",
                              body={"attemptId": attempt, "parts": [{"partNumber": 1, "sha256": wa.SHA}]},
                              path={"artifactId": self.pending})
        self.assertEqual(status, 200)


class ViewerImageTests(replacement.ReplacementTestCase):
    def setUp(self):
        super().setUp()
        wa.add_rows(self.table, wa.membership(VIEWER, W1, "viewer"))

    def test_views_and_downloads_images_but_cannot_change_them(self):
        aid = self.ready_image(USER, [D1])
        [result] = self.view_results(VIEWER, [aid])
        self.assertTrue(result["ok"], result)
        resp = self.lam("artifacts-get").handler(
            event(VIEWER, "/artifacts/{artifactId}/download", path={"artifactId": aid}), None)
        self.assertEqual(resp["statusCode"], 200)

        before = copy.deepcopy(self.meta(aid))
        self.assertEqual(self.start(VIEWER, aid)["statusCode"], 404)
        self.assertEqual(self.patch(VIEWER, aid, {"title": "Mine now"})["statusCode"], 404)
        self.assertEqual(self.meta(aid), before)
        # A member may.
        self.assertEqual(self.start(MEMBER, aid)["statusCode"], 200)

    def test_cannot_view_other_workspace_images(self):
        aid = self.ready_image(wa.W2_OWNER, [D3])
        [result] = self.view_results(VIEWER, [aid])
        self.assertEqual((result["ok"], result["status"]), (False, 404))


# --- CVEs -----------------------------------------------------------------------------

CVE_W = "0192c000-0000-7000-8000-000000000001"
CVE_B = "0192c000-0000-7000-8000-000000000002"
CVE_DEV = "11111111-1111-4111-8111-0000000000c1"
CVE_DEV2 = "11111111-1111-4111-8111-0000000000c2"


class ViewerCveTests(cves.ApiTestCase):
    rows = [
        *cves.workspace_rows(cves.WS_A, {cves.USER: "owner", cves.MEMBER: "member", VIEWER: "viewer"}),
        *cves.workspace_rows(cves.WS_B, {cves.OTHER_USER: "owner"}),
        *cves.workspace_device_rows(CVE_DEV, cves.WS_A),
        *cves.workspace_device_rows(CVE_DEV2, cves.WS_A),
        *cves.workspace_cve_rows(CVE_W, "CVE-2020-26652", cves.WS_A),
        *cves.workspace_cve_rows(CVE_B, "CVE-2021-37584", cves.WS_B),
    ]

    def setUp(self):
        super().setUp()
        # Link the workspace CVE to one device, as an owner would have.
        self.assertEqual(self.link(CVE_W, CVE_DEV)["statusCode"], 200)

    def test_reads_cves(self):
        resp = self.list(user=VIEWER, workspace_id=cves.WS_A)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual([c["cveRecordId"] for c in cves.response_body(resp)["cves"]], [CVE_W])
        resp = self.get(CVE_W, user=VIEWER)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(cves.response_body(resp)["cve"]["deviceIds"], [CVE_DEV])

    def test_cannot_change_cves(self):
        before, calls = snapshot(self.table), len(self.client.calls)
        attempts = [
            self.create({"cveId": "CVE-2024-0001", "severity": "high", "workspaceId": cves.WS_A}, user=VIEWER),
            self.patch(CVE_W, {"severity": "low"}, user=VIEWER),
            self.link(CVE_W, CVE_DEV2, user=VIEWER),
            self.unlink(CVE_W, CVE_DEV, user=VIEWER),
            self.delete(CVE_W, user=VIEWER),
        ]
        for resp in attempts:
            self.assertIn(resp["statusCode"], REFUSED, resp["body"])
        self.assertEqual(self.table.items, before)
        self.assertEqual(len(self.client.calls), calls)
        # Member control.
        self.assertEqual(self.patch(CVE_W, {"severity": "low"}, user=cves.MEMBER)["statusCode"], 200)

    def test_other_workspace_is_invisible(self):
        self.assertEqual(self.get(CVE_B, user=VIEWER)["statusCode"], 404)
        self.assertEqual(self.list(user=VIEWER, workspace_id=cves.WS_B)["statusCode"], 404)


# --- RE notebook ------------------------------------------------------------------------

class ViewerNotebookTests(notebook.NotebookTestCase):
    def setUp(self):
        super().setUp()
        wa.add_rows(self.table, [
            {"pk": f"USER#{VIEWER}", "sk": f"WORKSPACE#{notebook.WS_A}", "entity": "user-workspace", "role": "viewer"},
            {"pk": f"WORKSPACE#{notebook.WS_A}", "sk": f"USER#{VIEWER}", "entity": "workspace-user",
             "role": "viewer"},
        ])
        self.ids = self.setup_notebook(device=notebook.DEV_A)
        self.ok(200, "PUT", notebook.BASE + "/entries/{entryId}/content", device=notebook.DEV_A,
                body={"doc": notebook.paragraph_doc("UART at 115200"), "expectedContentVersion": 1},
                entryId=self.ids[2])

    def test_reads_notebook_and_entries(self):
        book = self.notebook(device=notebook.DEV_A, user=VIEWER)
        self.assertEqual(len(book["sections"]), 2)
        status, body = self.entry(self.ids[2], device=notebook.DEV_A, user=VIEWER)
        self.assertEqual(status, 200, body)
        self.assertIn("UART at 115200", json.dumps(body["doc"]))

    def test_every_write_is_refused(self):
        s1, s2, e1, e2, e3 = self.ids
        base = notebook.BASE
        writes = [
            ("POST", base + "/sections", {"title": "x"}, {}, None),
            ("PATCH", base + "/sections/{sectionId}", {"title": "x", "expectedVersion": 1}, {"sectionId": s1}, None),
            ("DELETE", base + "/sections/{sectionId}", None, {"sectionId": s2}, {"expectedVersion": "1"}),
            ("PUT", base + "/section-order", {"sectionIds": [s2, s1], "expectedOrderVersion": 2}, {}, None),
            ("POST", base + "/sections/{sectionId}/entries", {"title": "x"}, {"sectionId": s1}, None),
            ("PUT", base + "/sections/{sectionId}/entry-order", {"entryIds": [e2, e1], "expectedOrderVersion": 2},
             {"sectionId": s1}, None),
            ("PATCH", base + "/entries/{entryId}", {"title": "x", "expectedVersion": 1}, {"entryId": e1}, None),
            # Autosave.
            ("PUT", base + "/entries/{entryId}/content",
             {"doc": notebook.paragraph_doc("vandalised"), "expectedContentVersion": 2}, {"entryId": e3}, None),
            ("POST", base + "/entries/{entryId}/move", {"targetSectionId": s2, "expectedVersion": 1},
             {"entryId": e1}, None),
            ("DELETE", base + "/entries/{entryId}", None, {"entryId": e1},
             {"expectedVersion": "1", "expectedContentVersion": "1"}),
        ]
        before, calls = self.notebook_rows(notebook.DEV_A), len(self.client.calls)
        for method, resource, body, path, query in writes:
            with self.subTest(method=method, resource=resource):
                status, resp = self.call(method, resource, user=VIEWER, device=notebook.DEV_A, body=body,
                                         query=query, **path)
                self.assertEqual(status, 404, resp)
        self.assertEqual(self.notebook_rows(notebook.DEV_A), before)
        self.assertEqual(len(self.client.calls), calls)
        # Member control: the autosave write succeeds for a member.
        current = int(self.row(notebook.DEV_A, f"ENTRY#{e3}")["contentVersion"])
        status, resp = self.save(e3, notebook.paragraph_doc("member edit"), current, device=notebook.DEV_A,
                                 user=notebook.MEMBER)
        self.assertEqual(status, 200, resp)

    def test_other_workspace_and_personal_notebooks_are_invisible(self):
        for device in (notebook.DEV_B, notebook.DEV_P):
            status, _ = self.call("GET", notebook.BASE, user=VIEWER, device=device)
            self.assertEqual(status, 404)


# --- Runs -----------------------------------------------------------------------------

class ViewerRunTests(runs.RunsTestCase):
    def setUp(self):
        super().setUp()
        wa.add_rows(self.table, wa.membership(VIEWER, W1, "viewer"))
        # The viewer has a cloud script of their own, so nothing but the role
        # stands between them and a workspace run.
        wa.add_rows(self.table, runs.script("0192d000-0000-7000-8000-0000000000aa", VIEWER, "prof's script"))
        self.rid = self.started_member_run()

    def test_views_runs_logs_and_outputs(self):
        status, body = self.list_runs(VIEWER, W1)
        self.assertEqual((status, [r["runId"] for r in body["runs"]]), (200, [self.rid]))
        status, body = self.detail(VIEWER, self.rid)
        self.assertEqual(status, 200)
        self.assertFalse(body["canCancel"])
        self.table.items[(f"RUN#{self.rid}", "CHILD#00000")]["logStreamName"] = "stream-1"
        status, body = self.runs(VIEWER, "GET", "/runs/{runId}/children/{index}/log",
                                 path={"runId": self.rid, "index": "0"})
        self.assertEqual(status, 200, body)
        resp = self.lam("artifacts-list").handler(event(VIEWER, None, query={"runId": self.rid}), None)
        self.assertEqual(resp["statusCode"], 200)

    def test_cannot_estimate_start_or_cancel(self):
        batch = self.lam("runs-api").batch
        submitted = batch.submit_job.call_count
        before = snapshot(self.table)
        body = self.run_body({"deviceId": D1}, "0192d000-0000-7000-8000-0000000000aa", W1)
        for resource in ("/runs/estimate", "/runs"):
            status, resp = self.runs(VIEWER, "POST", resource, body)
            self.assertEqual(status, 403, resp)
        status, _ = self.cancel(VIEWER, self.rid)
        self.assertEqual(status, 403)
        self.assertEqual(self.table.items, before)
        self.assertEqual(batch.submit_job.call_count, submitted)
        batch.terminate_job.assert_not_called()

    def test_other_workspace_runs_are_invisible(self):
        status, _ = self.list_runs(VIEWER, W2)
        self.assertEqual(status, 404)


# --- Sessions ---------------------------------------------------------------------------

class ViewerSessionTests(unittest.TestCase):
    def test_cannot_start_a_session_over_workspace_files(self):
        with sessions._env({**sessions.ENV, "METADATA_TABLE_NAME": wa.TABLE}):
            module = wa.load_lambda("sessions-api")
        table = wa.FakeTable(wa.world() + wa.membership(VIEWER, W1, "viewer"))
        with self.assertRaises(module.RequestError) as caught:
            module._workspace_scope(table, VIEWER, W1)
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(module._workspace_scope(table, MEMBER, W1), W1)


if __name__ == "__main__":
    unittest.main()
