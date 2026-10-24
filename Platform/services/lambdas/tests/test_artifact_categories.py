"""Artifact categories: the kernel_module and report types next to the
original firmware / binary / pcap / log / other, through upload, listing
(personal, workspace and device), the firmware-only rules, runs and run
outputs. Same in-memory world as test_workspace_artifacts.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import json
import unittest

import test_workspace_artifacts as wa
import test_workspace_runs as wr
from test_workspace_artifacts import D1, D3, DP, MEMBER, OUTSIDER, SHA, USER, W1, W2_OWNER

NEW_TYPES = ("kernel_module", "report")


class CategoryUploadTests(wa.WorldTestCase):
    def test_new_types_upload_personally_without_firmware_rules(self):
        for artifact_type, name in (("kernel_module", "nf.ko"), ("report", "findings.pdf")):
            aid = self.upload(USER, [DP], name=name, artifact_type=artifact_type)
            meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
            self.assertEqual(meta["type"], artifact_type)
            self.assertNotIn("workspaceId", meta)
            self.assertNotIn("version", meta)
            self.assertNotIn("reverseEngineeringStatus", meta)
            self.assertIn((f"USER#{USER}", f"ARTIFACT#{aid}"), self.table.items)
            self.assertIn((f"DEVICE#{DP}", f"ARTIFACT#{artifact_type}#{aid}"), self.table.items)
        self.assertFalse([k for k in self.table.items if k[1].startswith("FWVER#")])

    def test_new_types_upload_to_a_workspace_device(self):
        for artifact_type in NEW_TYPES:
            aid = self.upload(MEMBER, [D1], artifact_type=artifact_type)
            meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
            self.assertEqual((meta["workspaceId"], meta["type"], meta["deviceIds"]), (W1, artifact_type, {D1}))
            link = self.table.items[(f"WORKSPACE#{W1}", f"ARTIFACT#{aid}")]
            self.assertEqual(link["type"], artifact_type)
            self.assertIn((f"DEVICE#{D1}", f"ARTIFACT#{artifact_type}#{aid}"), self.table.items)

    def test_version_is_still_firmware_only(self):
        spec = {**self.file("r.pdf", "report"), "version": "1.0"}
        [result] = wa.response_body(self.presign(USER, [spec]))["results"]
        self.assertEqual((result["ok"], result["error"]), (False, "version is only allowed for firmware"))

    def test_firmware_still_requires_a_version(self):
        spec = self.file("fw.bin", "firmware")
        del spec["version"]
        [result] = wa.response_body(self.presign(USER, [spec]))["results"]
        self.assertFalse(result["ok"])
        self.assertIn("Firmware needs a version", result["error"])

    def test_unknown_type_still_rejected(self):
        [result] = wa.response_body(self.presign(USER, [self.file("x.ko", "kernel-module")]))["results"]
        self.assertFalse(result["ok"])
        self.assertIn("kernel_module", result["error"])

    def test_reverse_engineering_status_rejected_for_new_types(self):
        aid = self.upload(USER, None, artifact_type="kernel_module")
        resp = self.lam("artifacts-update").handler(
            wa.event(USER, "/artifacts/{artifactId}", body={"reverseEngineeringStatus": "complete"},
                     path={"artifactId": aid}), None)
        self.assertEqual(resp["statusCode"], 400)


class CategoryListingTests(wa.WorldTestCase):
    def setUp(self):
        super().setUp()
        self.fw = self.upload(MEMBER, [D1])
        self.ko = self.upload(MEMBER, [D1], name="nf.ko", artifact_type="kernel_module")
        self.pdf = self.upload(MEMBER, [D1], name="r.pdf", artifact_type="report")
        self.other_ws = self.upload(W2_OWNER, [D3], artifact_type="report")
        self.personal_ko = self.upload(USER, [DP], name="p.ko", artifact_type="kernel_module")
        self.personal_pcap = self.upload(USER, None, artifact_type="pcap")

    def list(self, user, query=None, device=None):
        if device:
            event = wa.event(user, "/devices/{deviceId}/artifacts", path={"deviceId": device}, query=query)
        else:
            event = wa.event(user, "/artifacts", query=query)
        return self.lam("artifacts-list").handler(event, None)

    def ids(self, *args, **kwargs):
        resp = self.list(*args, **kwargs)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return {a["artifactId"] for a in wa.response_body(resp)["artifacts"]}

    def test_personal_category_filter(self):
        self.assertEqual(self.ids(USER, {"type": "kernel_module"}), {self.personal_ko})
        self.assertEqual(self.ids(USER, {"type": "report"}), set())
        self.assertEqual(self.ids(USER, {"type": "pcap"}), {self.personal_pcap})
        self.assertEqual(self.ids(USER), {self.personal_ko, self.personal_pcap})

    def test_workspace_category_filter_stays_in_the_workspace(self):
        self.assertEqual(self.ids(MEMBER, {"workspaceId": W1, "type": "report"}), {self.pdf})
        self.assertEqual(self.ids(MEMBER, {"workspaceId": W1, "type": "kernel_module"}), {self.ko})
        self.assertEqual(self.ids(MEMBER, {"workspaceId": W1, "type": "firmware"}), {self.fw})
        self.assertEqual(self.list(OUTSIDER, {"workspaceId": W1, "type": "report"})["statusCode"], 404)

    def test_device_category_filter_uses_the_type_prefix(self):
        self.table.queries.clear()
        self.assertEqual(self.ids(MEMBER, {"type": "kernel_module"}, device=D1), {self.ko})
        self.assertEqual(self.table.queries, [(f"DEVICE#{D1}", "ARTIFACT#kernel_module#")])
        self.assertEqual(self.ids(MEMBER, {"type": "report"}, device=D1), {self.pdf})
        self.assertEqual(self.ids(MEMBER, device=D1), {self.fw, self.ko, self.pdf})
        self.assertEqual(self.list(OUTSIDER, {"type": "report"}, device=D1)["statusCode"], 403)

    def test_batch_listing_keeps_the_category(self):
        batch = self.table.items[(f"ARTIFACT#{self.pdf}", "METADATA")]["uploadBatchId"]
        self.assertEqual(self.ids(MEMBER, {"batchId": batch, "type": "report"}), {self.pdf})
        self.assertEqual(self.ids(MEMBER, {"batchId": batch, "type": "pcap"}), set())

    def test_listed_new_types_have_no_reverse_engineering_status(self):
        resp = self.list(MEMBER, {"workspaceId": W1})
        by_id = {a["artifactId"]: a for a in wa.response_body(resp)["artifacts"]}
        self.assertEqual(by_id[self.ko]["type"], "kernel_module")
        self.assertNotIn("reverseEngineeringStatus", by_id[self.ko])
        self.assertEqual(by_id[self.fw]["reverseEngineeringStatus"], "not_started")

    def test_unknown_type_filter_still_rejected(self):
        self.assertEqual(self.list(USER, {"type": "pdf"})["statusCode"], 400)


class CategoryRunTests(wr.RunsTestCase):
    def estimate(self, user, inputs, workspace_id=W1):
        return self.runs(user, "POST", "/runs/estimate", self.run_body(inputs, workspace_id=workspace_id))

    def test_type_filter_and_device_source_accept_new_types(self):
        self.upload(USER, [D1], name="nf.ko", artifact_type="kernel_module")
        self.upload(USER, [D1], name="r.pdf", artifact_type="report")
        self.upload(USER, [D1], artifact_type="pcap")
        self.assertEqual(self.estimate(USER, {"type": "kernel_module"})[1]["inputCount"], 1)
        self.assertEqual(self.estimate(USER, {"deviceId": D1, "type": "report"})[1]["inputCount"], 1)
        self.assertEqual(self.estimate(USER, {"deviceId": D1})[1]["inputCount"], 3)
        self.assertEqual(self.estimate(USER, {"type": "pdf"})[0], 400)

    def test_group_by_require_types_accepts_new_types(self):
        self.upload(USER, [D1], name="a.ko", artifact_type="kernel_module")
        self.upload(USER, [D1], name="a.pdf", artifact_type="report")
        body = self.run_body({"deviceId": D1}, workspace_id=W1, mode="groupBy",
                             groupBy={"by": "stem", "requireTypes": ["kernel_module", "report"]})
        status, result = self.runs(USER, "POST", "/runs/estimate", body)
        self.assertEqual(status, 200, result)
        body["groupBy"]["requireTypes"] = ["kernel-module"]
        self.assertEqual(self.runs(USER, "POST", "/runs/estimate", body)[0], 400)

    def test_run_outputs_are_typed_by_extension(self):
        self.upload(USER, [D1], artifact_type="pcap")
        rid = self.start(MEMBER, {"deviceId": D1}, wr.MOD_MEMBER, W1)["runId"]
        types = self.output_types(rid, ["mod.KO", "out/report.v2.pdf", "fw.bin", "x.elf", "notes.json", "blob"])
        self.assertEqual(types, {"mod.KO": "kernel_module", "out/report.v2.pdf": "report", "fw.bin": "firmware",
                                 "x.elf": "binary", "notes.json": "log", "blob": "other"})

    def output_types(self, rid, paths):
        """Presigns one output per path through runs-manifest; returns {path: type}."""
        manifest = self.lam("runs-manifest")
        token = self.run_token()
        unit = self.table.items[(f"RUN#{rid}", "CHILD#00000")]["units"][0]["unitId"]

        def call(resource, body):
            resp = manifest.handler({"resource": resource, "headers": {"X-Run-Token": token},
                                     "body": json.dumps({"runId": rid, "childIndex": 0, **body})}, None)
            self.assertEqual(resp["statusCode"], 200, resp["body"])
            return json.loads(resp["body"])

        call("/manifest", {})
        files = call("/outputs/presign", {"unitId": unit, "attempt": "1", "files": [
            {"path": path, "sizeBytes": 5, "sha256": SHA} for path in paths]})["files"]
        types = {}
        for path, out in zip(paths, files):
            meta = self.table.items[(f"ARTIFACT#{out['artifactId']}", "METADATA")]
            types[path] = meta["type"]
            self.assertEqual("reverseEngineeringStatus" in meta, meta["type"] == "firmware")
        return types


if __name__ == "__main__":
    unittest.main()
