"""Workspace artifacts and firmware (Stage 3A.4): upload scope, reads,
listings, firmware status, batches, the legacy firmware routes and the runs
boundary, with DynamoDB and S3 replaced by in-memory fakes.

The world: W1 has USER (owner) and MEMBER; W2 has W2_OWNER. OUTSIDER belongs
to neither. D1 and D2 are W1 devices, D3 is a W2 device, DP is USER's
personal device. Artifacts are created through the real presign handler.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("DATA_LAKE_BUCKET", "data-lake")
os.environ.setdefault("VERIFY_FUNCTION_NAME", "verify")
os.environ.setdefault("MAX_FIRMWARE_SIZE_BYTES", str(25 * 1024 ** 2))
for name, value in (("QUEUES", "{}"), ("MANIFEST_URL", "https://manifest"), ("PRICING", "{}"),
                    ("RUN_LOG_GROUP", "runs")):
    os.environ.setdefault(name, value)

LAMBDAS = Path(__file__).resolve().parent.parent
# The shared layer (testbed_authz), which Lambda puts on the path from /opt/python.
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
TABLE = os.environ["METADATA_TABLE_NAME"]

USER = "user-ipule"
MEMBER = "user-justin"
W2_OWNER = "user-nathan"
OUTSIDER = "user-outsider"
W1 = "0192b000-0000-7000-8000-000000000001"
W2 = "0192b000-0000-7000-8000-000000000002"
D1 = "11111111-1111-4111-8111-111111111111"
D2 = "22222222-2222-4222-8222-222222222222"
D3 = "33333333-3333-4333-8333-333333333333"
DP = "44444444-4444-4444-8444-444444444444"
SHA = "a" * 64


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(user, resource=None, body=None, path=None, query=None):
    return {
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": path,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def response_body(resp):
    return json.loads(resp["body"])


# --- Fakes ------------------------------------------------------------------------


class FakeTable:
    """The boto3 Table calls the artifact Lambdas make. No scan() on purpose:
    a Scan anywhere fails the test outright."""

    def __init__(self, rows):
        self.items = {(r["pk"], r["sk"]): copy.deepcopy(r) for r in rows}
        self.queries = []

    def get_item(self, Key, **kwargs):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def query(self, KeyConditionExpression, ScanIndexForward=True, Limit=None, ExclusiveStartKey=None):
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        self.queries.append((pk, prefix))
        rows = sorted((copy.deepcopy(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
                      key=lambda r: r["sk"], reverse=not ScanIndexForward)
        return {"Items": rows[:Limit] if Limit else rows}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None,
                    ExpressionAttributeNames=None, ReturnValues=None):
        item = self.items.get((Key["pk"], Key["sk"]))
        values = ExpressionAttributeValues
        if UpdateExpression == "ADD fileCount :n, totalBytes :b SET updatedAt = :now":
            item = self.items.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
            item["fileCount"] = item.get("fileCount", 0) + values[":n"]
            item["totalBytes"] = item.get("totalBytes", 0) + values[":b"]
            item["updatedAt"] = values[":now"]
            return {}
        assert UpdateExpression == "SET reverseEngineeringStatus = :re_status, updatedAt = :now", UpdateExpression
        assert ConditionExpression == "attribute_exists(pk) AND #type = :firmware"
        if item is None or item.get("type") != "firmware":
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, "UpdateItem")
        item["reverseEngineeringStatus"] = values[":re_status"]
        item["updatedAt"] = values[":now"]
        return {"Attributes": copy.deepcopy(item)}


class FakeResource:
    def __init__(self, table):
        self.table = table

    def Table(self, name):
        assert name == TABLE
        return self.table

    def batch_get_item(self, RequestItems):
        keys = RequestItems[TABLE]["Keys"]
        found = [copy.deepcopy(i) for k in keys if (i := self.table.items.get((k["pk"], k["sk"])))]
        return {"Responses": {TABLE: found}, "UnprocessedKeys": {}}


CONDITIONS = {
    "attribute_not_exists(pk)": lambda item, v, n: item is None,
    "#role IN (:role0, :role1)":
        lambda item, v, n: item is not None and item.get(n["#role"]) in (v[":role0"], v[":role1"]),
}


class FakeClient:
    """transact_write_items applied all-or-nothing, with per-item
    CancellationReasons. fail_code cancels every transaction instead."""

    def __init__(self, table):
        self.table = table
        self.fail_code = None
        self.calls = []

    def transact_write_items(self, TransactItems):
        self.calls.append(TransactItems)
        deserialize = TypeDeserializer().deserialize
        writes, reasons = [], []
        for t in TransactItems:
            (op, spec), = t.items()
            assert spec["TableName"] == TABLE
            if op == "Put":
                item = {k: deserialize(v) for k, v in spec["Item"].items()}
                key = (item["pk"], item["sk"])
            else:
                key, item = tuple(deserialize(spec["Key"][k]) for k in ("pk", "sk")), None
            values = {k: deserialize(v) for k, v in (spec.get("ExpressionAttributeValues") or {}).items()}
            ok = CONDITIONS[spec["ConditionExpression"]](
                self.table.items.get(key), values, spec.get("ExpressionAttributeNames") or {})
            reasons.append({"Code": "None" if ok else "ConditionalCheckFailed"})
            writes.append((op, key, item))
        if self.fail_code:
            reasons = [{"Code": self.fail_code} for _ in TransactItems]
        if any(r["Code"] != "None" for r in reasons):
            raise ClientError({"Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                               "CancellationReasons": reasons}, "TransactWriteItems")
        for op, key, item in writes:
            if op == "Put":
                self.table.items[key] = item
        return {}


# --- World ------------------------------------------------------------------------


def membership(user, workspace_id, role):
    return [
        {"pk": f"USER#{user}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace", "role": role},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user}", "entity": "workspace-user", "role": role},
    ]


def workspace_device(device_id, workspace_id, name):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "deviceId": device_id, "name": name,
         "type": "pump", "status": "active", "workspaceId": workspace_id, "createdBy": USER},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"DEVICE#{device_id}", "entity": "workspace-device", "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "device-workspace"},
    ]


def personal_device(device_id, owner, name):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "name": name, "type": "pump",
         "status": "active"},
        {"pk": f"USER#{owner}", "sk": f"DEVICE#{device_id}", "entity": "user-device", "role": "owner", "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"USER#{owner}", "entity": "device-user", "role": "owner"},
    ]


def world():
    return (
        [{"pk": f"WORKSPACE#{W1}", "sk": "METADATA", "entity": "workspace", "workspaceId": W1, "name": "Lab"},
         {"pk": f"WORKSPACE#{W2}", "sk": "METADATA", "entity": "workspace", "workspaceId": W2, "name": "Other"}]
        + membership(USER, W1, "owner") + membership(MEMBER, W1, "member") + membership(W2_OWNER, W2, "owner")
        + workspace_device(D1, W1, "Pump 1") + workspace_device(D2, W1, "Pump 2")
        + workspace_device(D3, W2, "Other pump") + personal_device(DP, USER, "My pump")
    )


def add_rows(table, rows):
    table.items.update({(r["pk"], r["sk"]): copy.deepcopy(r) for r in rows})


class WorldTestCase(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable(world())
        self.client = FakeClient(self.table)
        self.modules = {}

    def lam(self, name):
        if name not in self.modules:
            module = load_lambda(name)
            module.dynamodb = FakeResource(self.table)
            module.client = self.client
            module.s3 = mock.Mock()
            module.s3.generate_presigned_post.return_value = {"url": "https://s3", "fields": {}}
            module.s3.generate_presigned_url.return_value = "https://download"
            module.s3.create_multipart_upload.return_value = {"UploadId": "upload-1"}
            self.modules[name] = module
        return self.modules[name]

    def file(self, name="fw.bin", artifact_type="firmware", version="1.0", size=10):
        spec = {"clientRef": name, "originalFilename": name, "sizeBytes": size, "sha256": SHA, "type": artifact_type}
        if artifact_type == "firmware":
            spec["version"] = version
        return spec

    def presign(self, user, files=None, **extra):
        body = {"files": files if files is not None else [self.file()], **extra}
        return self.lam("artifacts-presign").handler(event(user, "/artifacts/presign", body=body), None)

    def upload(self, user, device_ids, ready=True, **file_kwargs):
        """Presigns one file and returns its artifact id (marked ready)."""
        resp = self.presign(user, [self.file(**file_kwargs)], deviceIds=device_ids)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        [result] = response_body(resp)["results"]
        self.assertTrue(result["ok"], result)
        if ready:
            self.table.items[(f"ARTIFACT#{result['artifactId']}", "METADATA")]["status"] = "ready"
        return result["artifactId"]

    def keys_for(self, artifact_id):
        return {k for k in self.table.items if f"ARTIFACT#{artifact_id}" in k[0] or k[1].endswith(artifact_id)}


# --- Upload -----------------------------------------------------------------------


class WorkspaceUploadTests(WorldTestCase):
    def test_personal_upload_is_unchanged(self):
        resp = self.presign(USER, deviceIds=[DP])
        body = response_body(resp)
        self.assertNotIn("workspaceId", body)
        aid = body["results"][0]["artifactId"]
        batch = body["uploadBatchId"]
        meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
        self.assertNotIn("workspaceId", meta)
        self.assertEqual(meta["deviceIds"], {DP})
        self.assertEqual(self.keys_for(aid), {
            (f"ARTIFACT#{aid}", "METADATA"),
            (f"USER#{USER}", f"ARTIFACT#{aid}"), (f"ARTIFACT#{aid}", f"USER#{USER}"),
            (f"BATCH#{batch}", f"ARTIFACT#{aid}"),
            (f"DEVICE#{DP}", f"ARTIFACT#firmware#{aid}"), (f"ARTIFACT#{aid}", f"DEVICE#{DP}"),
        })
        self.assertIn((f"DEVICE#{DP}", "FWVER#1.0"), self.table.items)
        self.assertNotIn("workspaceId", self.table.items[(f"BATCH#{batch}", "METADATA")])
        self.assertIn((f"USER#{USER}", f"BATCH#{batch}"), self.table.items)

    def test_upload_without_devices_stays_personal(self):
        aid = self.upload(USER, None, artifact_type="pcap")
        self.assertNotIn("workspaceId", self.table.items[(f"ARTIFACT#{aid}", "METADATA")])
        self.assertIn((f"USER#{USER}", f"ARTIFACT#{aid}"), self.table.items)

    def test_injected_workspace_id_is_ignored(self):
        resp = self.presign(USER, [{**self.file(artifact_type="log"), "workspaceId": W1}], workspaceId=W1)
        aid = response_body(resp)["results"][0]["artifactId"]
        self.assertNotIn("workspaceId", self.table.items[(f"ARTIFACT#{aid}", "METADATA")])
        self.assertNotIn((f"WORKSPACE#{W1}", f"ARTIFACT#{aid}"), self.table.items)

    def test_member_uploads_firmware_to_workspace_device(self):
        resp = self.presign(MEMBER, deviceIds=[D1])
        body = response_body(resp)
        self.assertEqual(body["workspaceId"], W1)
        aid, batch = body["results"][0]["artifactId"], body["uploadBatchId"]
        meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
        self.assertEqual((meta["workspaceId"], meta["createdBy"], meta["type"], meta["version"]),
                         (W1, MEMBER, "firmware", "1.0"))
        self.assertEqual((meta["status"], meta["reverseEngineeringStatus"]), ("pending", "not_started"))
        self.assertEqual(self.keys_for(aid), {
            (f"ARTIFACT#{aid}", "METADATA"),
            (f"WORKSPACE#{W1}", f"ARTIFACT#{aid}"), (f"ARTIFACT#{aid}", f"WORKSPACE#{W1}"),
            (f"BATCH#{batch}", f"ARTIFACT#{aid}"),
            (f"DEVICE#{D1}", f"ARTIFACT#firmware#{aid}"), (f"ARTIFACT#{aid}", f"DEVICE#{D1}"),
        })
        link = self.table.items[(f"WORKSPACE#{W1}", f"ARTIFACT#{aid}")]
        self.assertEqual({k: link[k] for k in ("entity", "name", "type", "createdBy")},
                         {"entity": "workspace-artifact", "name": "fw.bin", "type": "firmware", "createdBy": MEMBER})
        self.assertEqual(self.table.items[(f"ARTIFACT#{aid}", f"WORKSPACE#{W1}")]["entity"], "artifact-workspace")
        self.assertEqual(self.table.items[(f"DEVICE#{D1}", "FWVER#1.0")]["artifactId"], aid)

    def test_workspace_artifact_has_no_ownership_rows(self):
        aid = self.upload(MEMBER, [D1])
        self.assertFalse([k for k in self.table.items if k[0].startswith("USER#") and k[1] == f"ARTIFACT#{aid}"])
        self.assertFalse([k for k in self.table.items if k[0] == f"ARTIFACT#{aid}" and k[1].startswith("USER#")])

    def test_workspace_batch(self):
        resp = self.presign(MEMBER, deviceIds=[D1])
        batch = response_body(resp)["uploadBatchId"]
        meta = self.table.items[(f"BATCH#{batch}", "METADATA")]
        self.assertEqual((meta["workspaceId"], meta["createdBy"], meta["fileCount"]), (W1, MEMBER, 1))
        self.assertIn((f"WORKSPACE#{W1}", f"BATCH#{batch}"), self.table.items)
        self.assertIn((f"BATCH#{batch}", f"WORKSPACE#{W1}"), self.table.items)
        self.assertFalse([k for k in self.table.items if k[1] == f"BATCH#{batch}" and k[0].startswith("USER#")])

    def test_owner_uploads_to_workspace_device(self):
        aid = self.upload(USER, [D1, D2])
        meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
        self.assertEqual((meta["workspaceId"], meta["deviceIds"]), (W1, {D1, D2}))
        for device in (D1, D2):
            self.assertIn((f"DEVICE#{device}", f"ARTIFACT#firmware#{aid}"), self.table.items)
            self.assertIn((f"DEVICE#{device}", "FWVER#1.0"), self.table.items)

    def test_every_artifact_type_can_be_uploaded_to_a_workspace_device(self):
        resp = self.presign(MEMBER, [self.file("a.pcap", "pcap"), self.file("a.log", "log"),
                                     self.file("big.bin", "binary", size=100 * 1024 ** 2)], deviceIds=[D1])
        results = response_body(resp)["results"]
        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual([r["upload"]["mode"] for r in results], ["single", "single", "multipart"])
        for r in results:
            self.assertEqual(self.table.items[(f"ARTIFACT#{r['artifactId']}", "METADATA")]["workspaceId"], W1)

    def test_non_member_rejected(self):
        before = copy.deepcopy(self.table.items)
        resp = self.presign(OUTSIDER, deviceIds=[D1])
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.table.items, before)

    def test_mixed_personal_and_workspace_devices_rejected(self):
        before = copy.deepcopy(self.table.items)
        resp = self.presign(USER, deviceIds=[DP, D1])
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("same workspace", response_body(resp)["error"])
        self.assertEqual(self.table.items, before)  # not even a batch

    def test_devices_from_two_workspaces_rejected(self):
        add_rows(self.table, membership(USER, W2, "member"))
        before = copy.deepcopy(self.table.items)
        self.assertEqual(self.presign(USER, deviceIds=[D1, D3])["statusCode"], 400)
        self.assertEqual(self.table.items, before)

    def test_stale_device_owner_row_does_not_authorize(self):
        add_rows(self.table, personal_device(D1, OUTSIDER, "Pump 1")[1:])  # leftover USER#/DEVICE# rows
        self.assertEqual(self.presign(OUTSIDER, deviceIds=[D1])["statusCode"], 403)

    def test_workspace_device_link_alone_does_not_authorize(self):
        # A W1 link pointing at W2_OWNER's personal device doesn't let W1 members use it.
        add_rows(self.table, personal_device("55555555-5555-4555-8555-555555555555", W2_OWNER, "Theirs") + [
            {"pk": f"WORKSPACE#{W1}", "sk": "DEVICE#55555555-5555-4555-8555-555555555555"},
            {"pk": "DEVICE#55555555-5555-4555-8555-555555555555", "sk": f"WORKSPACE#{W1}"},
        ])
        self.assertEqual(self.presign(MEMBER, deviceIds=["55555555-5555-4555-8555-555555555555"])["statusCode"], 403)

    def test_firmware_version_unique_per_workspace_device(self):
        first = self.upload(USER, [D1])
        resp = self.presign(MEMBER, deviceIds=[D1])
        [result] = response_body(resp)["results"]
        self.assertEqual((result["ok"], result["status"]), (False, 409))
        self.assertIn("1.0", result["error"])
        artifacts = [k for k in self.table.items if k[0].startswith("ARTIFACT#") and k[1] == "METADATA"]
        self.assertEqual(artifacts, [(f"ARTIFACT#{first}", "METADATA")])
        self.assertEqual(self.upload(MEMBER, [D1], version="1.1") != first, True)

    def test_failed_batch_transaction_leaves_nothing(self):
        # As for personal uploads, a failed batch transaction isn't caught
        # (API Gateway answers 502) and nothing is written.
        self.client.fail_code = "ThrottlingError"
        before = set(self.table.items)
        with self.assertRaises(ClientError):
            self.presign(MEMBER, deviceIds=[D1])
        self.assertEqual(set(self.table.items), before)

    def test_failed_artifact_transaction_leaves_no_ownership_or_links(self):
        batch = response_body(self.presign(MEMBER, deviceIds=[D1]))["uploadBatchId"]
        before = set(self.table.items)
        self.client.fail_code = "ThrottlingError"
        resp = self.presign(MEMBER, [self.file(version="2.0")], deviceIds=[D1], uploadBatchId=batch)
        [result] = response_body(resp)["results"]
        self.assertEqual((result["ok"], result["status"]), (False, 500))
        self.assertEqual(set(self.table.items), before)

    def test_membership_removed_before_artifact_write(self):
        batch = response_body(self.presign(MEMBER, deviceIds=[D1]))["uploadBatchId"]
        before = set(self.table.items)
        real = self.lam("artifacts-presign").testbed_authz.require_resource

        def removed_after_check(table, user_id, kind, *args, **kwargs):
            # Membership disappears after the last check (the batch), just
            # before the artifact transaction.
            item = real(table, user_id, kind, *args, **kwargs)
            if kind == "BATCH":
                self.table.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{W1}"), None)
            return item

        with mock.patch.object(self.lam("artifacts-presign").testbed_authz, "require_resource", removed_after_check):
            resp = self.presign(MEMBER, [self.file(version="2.0")], deviceIds=[D1], uploadBatchId=batch)
        [result] = response_body(resp)["results"]
        self.assertEqual((result["ok"], result["status"]), (False, 403))
        before.discard((f"USER#{MEMBER}", f"WORKSPACE#{W1}"))
        self.assertEqual(set(self.table.items), before)

    def test_batch_reuse_follows_scope(self):
        ws_batch = response_body(self.presign(USER, deviceIds=[D1]))["uploadBatchId"]
        personal_batch = response_body(self.presign(USER, deviceIds=[DP]))["uploadBatchId"]
        # Another member adds to the workspace batch.
        resp = self.presign(MEMBER, [self.file(version="2.0")], deviceIds=[D2], uploadBatchId=ws_batch)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.table.items[(f"BATCH#{ws_batch}", "METADATA")]["fileCount"], 2)
        # Scopes can't be mixed in a batch.
        self.assertEqual(self.presign(USER, [self.file(version="3.0")], deviceIds=[DP],
                                      uploadBatchId=ws_batch)["statusCode"], 409)
        self.assertEqual(self.presign(USER, [self.file(version="3.0")], deviceIds=[D1],
                                      uploadBatchId=personal_batch)["statusCode"], 409)
        self.assertEqual(self.presign(USER, [self.file(artifact_type="log")],
                                      uploadBatchId=ws_batch)["statusCode"], 409)
        # Someone outside W1 can't use W1's batch, even for their own devices.
        self.assertEqual(self.presign(W2_OWNER, [self.file(version="3.0")], deviceIds=[D3],
                                      uploadBatchId=ws_batch)["statusCode"], 404)


# --- Reads ------------------------------------------------------------------------


class WorkspaceArtifactReadTests(WorldTestCase):
    def setUp(self):
        super().setUp()
        self.f1 = self.upload(USER, [D1])
        self.personal = self.upload(USER, [DP], version="9.0")

    def get(self, user, artifact_id, download=False):
        resource = "/artifacts/{artifactId}/download" if download else "/artifacts/{artifactId}"
        return self.lam("artifacts-get").handler(event(user, resource, path={"artifactId": artifact_id}), None)

    def test_member_gets_workspace_artifact(self):
        resp = self.get(MEMBER, self.f1)
        self.assertEqual(resp["statusCode"], 200)
        artifact = response_body(resp)["artifact"]
        self.assertEqual((artifact["artifactId"], artifact["workspaceId"]), (self.f1, W1))
        self.assertEqual(artifact["devices"], [{"deviceId": D1, "name": "Pump 1"}])

    def test_member_downloads_workspace_artifact(self):
        resp = self.get(MEMBER, self.f1, download=True)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["url"], "https://download")

    def test_outsider_cannot_read_or_download(self):
        for download in (False, True):
            self.assertEqual(self.get(OUTSIDER, self.f1, download)["statusCode"], 404)
            self.assertEqual(self.get(W2_OWNER, self.f1, download)["statusCode"], 404)

    def test_stale_artifact_owner_row_does_not_bypass_membership(self):
        add_rows(self.table, [
            {"pk": f"USER#{OUTSIDER}", "sk": f"ARTIFACT#{self.f1}", "entity": "user-artifact", "role": "owner"},
            {"pk": f"ARTIFACT#{self.f1}", "sk": f"USER#{OUTSIDER}", "entity": "artifact-user", "role": "owner"},
        ])
        for download in (False, True):
            self.assertEqual(self.get(OUTSIDER, self.f1, download)["statusCode"], 404)

    def test_workspace_artifact_link_alone_does_not_authorize(self):
        add_rows(self.table, [{"pk": f"WORKSPACE#{W1}", "sk": f"ARTIFACT#{self.personal}"},
                              {"pk": f"ARTIFACT#{self.personal}", "sk": f"WORKSPACE#{W1}"}])
        self.assertEqual(self.get(MEMBER, self.personal)["statusCode"], 404)
        self.assertEqual(self.get(USER, self.personal)["statusCode"], 200)

    def test_personal_artifact_unchanged(self):
        artifact = response_body(self.get(USER, self.personal))["artifact"]
        self.assertNotIn("workspaceId", artifact)
        self.assertEqual(self.get(MEMBER, self.personal)["statusCode"], 404)

    def test_member_completes_and_gets_part_urls(self):
        complete = self.lam("artifacts-complete")
        meta = self.table.items[(f"ARTIFACT#{self.f1}", "METADATA")]
        body = {"items": [{"artifactId": self.f1, "attemptId": meta["attemptId"]}]}
        result = response_body(complete.handler(event(MEMBER, body=body), None))["results"][0]
        self.assertEqual((result["ok"], result["status"]), (True, "ready"))
        result = response_body(complete.handler(event(OUTSIDER, body=body), None))["results"][0]
        self.assertEqual((result["ok"], result["status"]), (False, 404))

        big = response_body(self.presign(USER, [self.file("big.bin", "binary", size=100 * 1024 ** 2)],
                                         deviceIds=[D1]))["results"][0]
        parts = {"attemptId": big["attemptId"], "parts": [{"partNumber": 1, "sha256": SHA}]}
        presign = self.lam("artifacts-presign")
        resp = presign.handler(event(MEMBER, "/artifacts/{artifactId}/parts", body=parts,
                                     path={"artifactId": big["artifactId"]}), None)
        self.assertEqual(resp["statusCode"], 200)
        for user in (OUTSIDER, W2_OWNER):
            for resource in ("/artifacts/{artifactId}/parts", "/artifacts/{artifactId}/retry"):
                resp = presign.handler(event(user, resource, body=parts, path={"artifactId": big["artifactId"]}), None)
                self.assertEqual(resp["statusCode"], 404)


class WorkspaceFirmwareStatusTests(WorldTestCase):
    def setUp(self):
        super().setUp()
        self.f1 = self.upload(USER, [D1])

    def patch(self, user, status="complete"):
        return self.lam("artifacts-update").handler(event(user, "/artifacts/{artifactId}",
                                                          body={"reverseEngineeringStatus": status},
                                                          path={"artifactId": self.f1}), None)

    def status(self):
        return self.table.items[(f"ARTIFACT#{self.f1}", "METADATA")]["reverseEngineeringStatus"]

    def test_member_and_owner_can_change_status(self):
        self.assertEqual(self.patch(MEMBER, "in_progress")["statusCode"], 200)
        self.assertEqual(self.status(), "in_progress")
        self.assertEqual(self.patch(USER, "complete")["statusCode"], 200)
        self.assertEqual(self.status(), "complete")

    def test_outsider_cannot_change_status(self):
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(self.patch(user)["statusCode"], 404)
        self.assertEqual(self.status(), "not_started")

    def test_stale_owner_cannot_change_status(self):
        add_rows(self.table, [{"pk": f"USER#{OUTSIDER}", "sk": f"ARTIFACT#{self.f1}", "role": "owner"}])
        self.assertEqual(self.patch(OUTSIDER)["statusCode"], 404)
        self.assertEqual(self.status(), "not_started")


# --- Listings ---------------------------------------------------------------------


class WorkspaceListingTests(WorldTestCase):
    def setUp(self):
        super().setUp()
        self.f1 = self.upload(USER, [D1])
        self.pcap = self.upload(MEMBER, [D2], artifact_type="pcap")
        self.w2 = self.upload(W2_OWNER, [D3])
        self.personal = self.upload(USER, [DP])

    def list(self, user, query=None, device=None):
        if device:
            return self.lam("artifacts-list").handler(
                event(user, "/devices/{deviceId}/artifacts", path={"deviceId": device}, query=query), None)
        return self.lam("artifacts-list").handler(event(user, "/artifacts", query=query), None)

    def ids(self, *args, **kwargs):
        resp = self.list(*args, **kwargs)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return {a["artifactId"] for a in response_body(resp)["artifacts"]}

    def test_personal_list_unchanged_and_excludes_workspace_artifacts(self):
        self.assertEqual(self.ids(USER), {self.personal})
        self.assertEqual(self.ids(MEMBER), set())

    def test_stale_owner_row_does_not_put_workspace_artifact_in_personal_list(self):
        add_rows(self.table, [{"pk": f"USER#{USER}", "sk": f"ARTIFACT#{self.f1}", "role": "owner"}])
        self.assertEqual(self.ids(USER), {self.personal})

    def test_member_lists_workspace_artifacts(self):
        resp = self.list(MEMBER, {"workspaceId": W1})
        body = response_body(resp)
        self.assertEqual(body["workspaceId"], W1)
        self.assertEqual({a["artifactId"] for a in body["artifacts"]}, {self.f1, self.pcap})
        self.assertTrue(all(a["workspaceId"] == W1 for a in body["artifacts"]))
        self.assertEqual(self.ids(USER, {"workspaceId": W1, "type": "pcap"}), {self.pcap})

    def test_outsider_cannot_list_workspace(self):
        for user in (OUTSIDER, W2_OWNER):
            resp = self.list(user, {"workspaceId": W1})
            self.assertEqual(resp["statusCode"], 404)
            self.assertEqual(response_body(resp), {"error": "Workspace not found"})

    def test_bad_or_unknown_workspace(self):
        self.assertEqual(self.list(USER, {"workspaceId": "nope"})["statusCode"], 400)
        self.assertEqual(self.list(USER, {"workspaceId": "0192b000-0000-7000-8000-0000000000ff"})["statusCode"], 404)

    def test_workspaces_are_isolated(self):
        self.assertEqual(self.ids(W2_OWNER, {"workspaceId": W2}), {self.w2})

    def test_forged_workspace_links_expose_nothing(self):
        add_rows(self.table, [{"pk": f"WORKSPACE#{W1}", "sk": f"ARTIFACT#{self.w2}"},
                              {"pk": f"WORKSPACE#{W1}", "sk": f"ARTIFACT#{self.personal}"}])
        self.assertEqual(self.ids(MEMBER, {"workspaceId": W1}), {self.f1, self.pcap})

    def test_workspace_listing_uses_one_query_and_no_scan(self):
        self.table.queries.clear()
        self.ids(MEMBER, {"workspaceId": W1})
        self.assertEqual(self.table.queries, [(f"WORKSPACE#{W1}", "ARTIFACT#")])

    def test_device_firmware_list_for_members(self):
        for user in (USER, MEMBER):
            self.assertEqual(self.ids(user, {"type": "firmware"}, device=D1), {self.f1})
        self.assertEqual(self.ids(MEMBER, device=D2), {self.pcap})
        self.assertEqual(self.ids(USER, device=DP), {self.personal})

    def test_device_firmware_list_denied_to_outsiders(self):
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(self.list(user, device=D1)["statusCode"], 403)
        self.assertEqual(self.list(MEMBER, device=DP)["statusCode"], 403)

    def test_stale_device_owner_row_cannot_list_workspace_device(self):
        add_rows(self.table, personal_device(D1, OUTSIDER, "Pump 1")[1:])
        self.assertEqual(self.list(OUTSIDER, device=D1)["statusCode"], 403)

    def test_device_listing_requires_matching_artifact_scope(self):
        # Forged DEVICE#/ARTIFACT# rows: another workspace's artifact and a
        # personal artifact on a W1 device, and a W1 artifact on a personal device.
        add_rows(self.table, [
            {"pk": f"DEVICE#{D1}", "sk": f"ARTIFACT#firmware#{self.w2}"},
            {"pk": f"DEVICE#{D1}", "sk": f"ARTIFACT#firmware#{self.personal}"},
            {"pk": f"DEVICE#{DP}", "sk": f"ARTIFACT#firmware#{self.f1}"},
        ])
        self.assertEqual(self.ids(MEMBER, device=D1), {self.f1})
        self.assertEqual(self.ids(USER, device=DP), {self.personal})

    def test_workspace_batch_listing(self):
        batch = self.table.items[(f"ARTIFACT#{self.f1}", "METADATA")]["uploadBatchId"]
        resp = self.list(MEMBER, {"batchId": batch})
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual({a["artifactId"] for a in response_body(resp)["artifacts"]}, {self.f1})
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(self.list(user, {"batchId": batch})["statusCode"], 404)

    def test_batches_list_stays_personal(self):
        batch = self.table.items[(f"ARTIFACT#{self.f1}", "METADATA")]["uploadBatchId"]
        add_rows(self.table, [{"pk": f"USER#{USER}", "sk": f"BATCH#{batch}", "role": "owner"}])  # stale row
        resp = self.lam("artifacts-list").handler(event(USER, "/artifacts/batches"), None)
        listed = {b["uploadBatchId"] for b in response_body(resp)["batches"]}
        personal_batch = self.table.items[(f"ARTIFACT#{self.personal}", "METADATA")]["uploadBatchId"]
        self.assertEqual(listed, {personal_batch})


# --- Legacy firmware routes and runs --------------------------------------------------


class LegacyFirmwareRouteTests(WorldTestCase):
    def call(self, name, user, device, version=None, body=None):
        path = {"deviceId": device}
        if version:
            path["version"] = version
        return self.lam(name).handler(event(user, body=body or {}, path=path), None)

    def test_workspace_devices_are_refused_even_for_members(self):
        for user in (USER, MEMBER):
            self.assertEqual(self.call("list-firmware", user, D1)["statusCode"], 403)
            self.assertEqual(self.call("presign-firmware", user, D1)["statusCode"], 403)
            self.assertEqual(self.call("complete-firmware", user, D1, "1.0", {"attemptId": "a"})["statusCode"], 403)

    def test_stale_owner_row_does_not_reopen_them(self):
        add_rows(self.table, personal_device(D1, OUTSIDER, "Pump 1")[1:])
        self.assertEqual(self.call("list-firmware", OUTSIDER, D1)["statusCode"], 403)
        self.assertEqual(self.call("presign-firmware", OUTSIDER, D1)["statusCode"], 403)

    def test_personal_devices_still_work(self):
        self.assertEqual(self.call("list-firmware", USER, DP)["statusCode"], 200)
        self.assertEqual(self.call("list-firmware", MEMBER, DP)["statusCode"], 403)


class RunsBoundaryTests(WorldTestCase):
    # Workspace runs are covered in test_workspace_runs.
    def test_workspace_artifacts_are_never_personal_run_inputs(self):
        runs = self.lam("runs-api")
        f1 = self.upload(USER, [D1])
        personal = self.upload(USER, [DP])
        items, _ = runs._resolve_inputs(self.table, USER, {"artifactIds": [f1, personal]})
        self.assertEqual([i["artifactId"] for i in items], [personal])
        # Nor through the device or batch sources.
        batch = self.table.items[(f"ARTIFACT#{f1}", "METADATA")]["uploadBatchId"]
        for inputs in ({"deviceId": D1}, {"batchId": batch}):
            with self.assertRaises(runs.RequestError):
                runs._resolve_inputs(self.table, USER, inputs)


class EndToEndTests(WorldTestCase):
    def test_ipule_uploads_justin_works_with_it_outsider_cannot(self):
        f1 = self.upload(USER, [D1])
        get = self.lam("artifacts-get")
        self.assertEqual(get.handler(event(MEMBER, "/artifacts/{artifactId}", path={"artifactId": f1}), None)["statusCode"], 200)
        self.assertEqual(get.handler(event(MEMBER, "/artifacts/{artifactId}/download",
                                           path={"artifactId": f1}), None)["statusCode"], 200)
        update = self.lam("artifacts-update")
        resp = update.handler(event(MEMBER, "/artifacts/{artifactId}", body={"reverseEngineeringStatus": "complete"},
                                    path={"artifactId": f1}), None)
        self.assertEqual(resp["statusCode"], 200)
        self.upload(MEMBER, [D1], version="1.1")
        listed = response_body(self.lam("artifacts-list").handler(
            event(MEMBER, "/devices/{deviceId}/artifacts", path={"deviceId": D1}, query={"type": "firmware"}), None))
        self.assertEqual(len(listed["artifacts"]), 2)
        self.assertEqual(get.handler(event(OUTSIDER, "/artifacts/{artifactId}", path={"artifactId": f1}), None)["statusCode"], 404)


if __name__ == "__main__":
    unittest.main()
