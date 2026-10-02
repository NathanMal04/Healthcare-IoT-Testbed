"""Unit tests for firmware reverseEngineeringStatus: the artifact creation
paths (artifacts-presign, runs-manifest), the read paths (artifacts-list,
artifacts-get) and PATCH /artifacts/{artifactId} (artifacts-update), with
DynamoDB and S3 replaced by in-memory fakes and mocks.

Needs boto3 (as in the Lambda runtime), no AWS access:

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest import mock

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("DATA_LAKE_BUCKET", "data-lake")

LAMBDAS = Path(__file__).resolve().parent.parent
TABLE = os.environ["METADATA_TABLE_NAME"]

USER = "user-sub-1"
OTHER_USER = "user-sub-2"
DEVICE = "11111111-1111-4111-8111-111111111111"
FIRMWARE = "0192a000-0000-7000-8000-000000000001"
PCAP = "0192a000-0000-7000-8000-000000000002"
LEGACY_FIRMWARE = "0192a000-0000-7000-8000-000000000003"
MISSING = "0192a000-0000-7000-8000-0000000000ff"
SHA = "a" * 64


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(user=USER, body=None, resource=None, path=None, query=None):
    return {
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": path,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def response_body(resp):
    return json.loads(resp["body"])


def put_items(transact_mock):
    """Every item Put through client.transact_write_items, deserialized."""
    items = []
    for call in transact_mock.call_args_list:
        for t in call.kwargs["TransactItems"]:
            items.append({k: TypeDeserializer().deserialize(v) for k, v in t["Put"]["Item"].items()})
    return items


def artifact_items(transact_mock):
    return [i for i in put_items(transact_mock) if i["entity"] == "artifact"]


def artifact(artifact_id, artifact_type, owner=USER, **extra):
    item = {
        "pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA", "entity": "artifact",
        "artifactId": artifact_id, "name": f"{artifact_type}.bin", "type": artifact_type,
        "origin": "upload", "status": "ready", "statusUpdatedAt": "2026-09-01T00:00:00+00:00",
        "sha256": SHA, "sizeBytes": 10, "originalFilename": f"{artifact_type}.bin",
        "attemptId": "attempt-1", "uploadMode": "single", "createdBy": owner,
        "createdAt": "2026-09-01T00:00:00+00:00", "updatedAt": "2026-09-01T00:00:00+00:00",
        **extra,
    }
    return [
        item,
        {"pk": f"USER#{owner}", "sk": f"ARTIFACT#{artifact_id}", "entity": "user-artifact", "role": "owner"},
        {"pk": f"ARTIFACT#{artifact_id}", "sk": f"USER#{owner}", "entity": "artifact-user", "role": "owner"},
        {"pk": f"DEVICE#{DEVICE}", "sk": f"ARTIFACT#{artifact_type}#{artifact_id}", "entity": "device-artifact"},
    ]


def standard_rows():
    return (
        artifact(FIRMWARE, "firmware", version="1.0", reverseEngineeringStatus="in_progress")
        # Stored before Stage 2: no reverseEngineeringStatus attribute.
        + artifact(LEGACY_FIRMWARE, "firmware", version="0.9")
        + artifact(PCAP, "pcap")
        + [{"pk": f"USER#{USER}", "sk": f"DEVICE#{DEVICE}", "entity": "user-device", "role": "owner", "name": "Pump"}]
    )


class FakeTable:
    """Just enough of a boto3 Table for the artifact Lambdas under test."""

    def __init__(self, rows):
        self.items = {(r["pk"], r["sk"]): copy.deepcopy(r) for r in rows}
        self.update_calls = []

    def get_item(self, Key):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def query(self, KeyConditionExpression, ScanIndexForward=True, Limit=None, ExclusiveStartKey=None):
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        rows = sorted(
            (copy.deepcopy(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
            key=lambda r: r["sk"], reverse=not ScanIndexForward,
        )
        return {"Items": rows[:Limit] if Limit else rows}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ReturnValues):
        # The exact shape artifacts-update sends; anything else fails loudly.
        self.update_calls.append(Key)
        assert UpdateExpression == "SET reverseEngineeringStatus = :re_status, updatedAt = :now"
        assert ConditionExpression == "attribute_exists(pk) AND #type = :firmware"
        assert ExpressionAttributeNames == {"#type": "type"}
        item = self.items.get((Key["pk"], Key["sk"]))
        if item is None or item.get("type") != ExpressionAttributeValues[":firmware"]:
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "failed"}}, "UpdateItem"
            )
        item["reverseEngineeringStatus"] = ExpressionAttributeValues[":re_status"]
        item["updatedAt"] = ExpressionAttributeValues[":now"]
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


# --- Creation paths -------------------------------------------------------------


class PresignTests(unittest.TestCase):
    """Dashboard "Upload Firmware" and the Artifacts uploader both go through
    POST /artifacts/presign."""

    def setUp(self):
        self.module = load_lambda("artifacts-presign")
        self.table = mock.Mock()
        self.table.get_item.side_effect = lambda Key: (
            {"Item": {"role": "owner", "name": "Pump"}} if Key == {"pk": f"USER#{USER}", "sk": f"DEVICE#{DEVICE}"} else {}
        )
        self.module.dynamodb = mock.Mock(Table=mock.Mock(return_value=self.table))
        self.module.client = mock.Mock()
        self.module.s3 = mock.Mock()
        self.module.s3.generate_presigned_post.return_value = {"url": "https://s3", "fields": {}}

    def presign(self, files, **extra):
        resp = self.module.handler(event(resource="/artifacts/presign", body={"files": files, **extra}), None)
        self.assertEqual(resp["statusCode"], 200)
        results = response_body(resp)["results"]
        self.assertTrue(all(r["ok"] for r in results), results)
        return artifact_items(self.module.client.transact_write_items)

    def file(self, name, artifact_type, **extra):
        return {"clientRef": name, "originalFilename": name, "sizeBytes": 10, "sha256": SHA, "type": artifact_type, **extra}

    def test_dashboard_firmware_upload_defaults_to_not_started(self):
        [item] = self.presign([self.file("fw.bin", "firmware", version="1.0")], deviceIds=[DEVICE])
        self.assertEqual(item["reverseEngineeringStatus"], "not_started")
        # The upload lifecycle status is untouched and separate.
        self.assertEqual(item["status"], "pending")

    def test_artifacts_page_folder_upload(self):
        items = self.presign([
            self.file("results/filesystem.bin", "firmware", version="2.0"),
            self.file("results/capture.pcap", "pcap"),
            self.file("results/extraction.log", "log"),
            self.file("results/tool.elf", "binary"),
            self.file("results/report.json", "other"),
        ], tags=["lab-1"])
        by_type = {i["type"]: i for i in items}
        self.assertEqual(by_type["firmware"]["reverseEngineeringStatus"], "not_started")
        for artifact_type in ("pcap", "log", "binary", "other"):
            self.assertNotIn("reverseEngineeringStatus", by_type[artifact_type])
        self.assertTrue(all(i["status"] == "pending" for i in items))

    def test_link_rows_do_not_carry_the_status(self):
        self.presign([self.file("fw.bin", "firmware", version="1.0")], deviceIds=[DEVICE])
        links = [i for i in put_items(self.module.client.transact_write_items) if i["entity"] != "artifact"]
        self.assertTrue(links)
        self.assertTrue(all("reverseEngineeringStatus" not in i for i in links))


class RunOutputTests(unittest.TestCase):
    """runs-manifest registers run outputs as artifacts and types them by
    extension, so a .bin output becomes firmware (without a version)."""

    def setUp(self):
        self.module = load_lambda("runs-manifest")
        self.module.client = mock.Mock()
        self.module.s3 = mock.Mock()
        self.module.s3.generate_presigned_post.return_value = {"url": "https://s3", "fields": {}}
        self.table = mock.Mock()
        self.table.get_item.return_value = {}

    def test_firmware_output_gets_default_and_others_do_not(self):
        run = {"runId": "run-1", "createdBy": USER}
        child = {"units": [{"unitId": "unit-1", "key": "k", "artifactIds": [FIRMWARE]}]}
        body = {"unitId": "unit-1", "attempt": "1", "files": [
            {"path": "out/extracted.bin", "sizeBytes": 5, "sha256": SHA},
            {"path": "out/strings.log", "sizeBytes": 5, "sha256": SHA},
        ]}
        self.module._presign_outputs(self.table, run, child, body)

        by_name = {i["name"]: i for i in artifact_items(self.module.client.transact_write_items)}
        self.assertEqual(by_name["extracted.bin"]["type"], "firmware")
        self.assertEqual(by_name["extracted.bin"]["reverseEngineeringStatus"], "not_started")
        self.assertEqual(by_name["extracted.bin"]["origin"], "run")
        self.assertEqual(by_name["extracted.bin"]["status"], "pending")
        self.assertNotIn("reverseEngineeringStatus", by_name["strings.log"])


# --- Read paths -------------------------------------------------------------------


class ReadPathTests(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable(standard_rows())
        self.list_module = load_lambda("artifacts-list")
        self.list_module.dynamodb = FakeResource(self.table)
        self.get_module = load_lambda("artifacts-get")
        self.get_module.dynamodb = FakeResource(self.table)
        self.get_module.s3 = mock.Mock()
        self.get_module.s3.generate_presigned_url.return_value = "https://download"

    def list(self, **kwargs):
        resp = self.list_module.handler(event(**kwargs), None)
        self.assertEqual(resp["statusCode"], 200)
        return {a["artifactId"]: a for a in response_body(resp)["artifacts"]}

    def test_device_firmware_listing(self):
        artifacts = self.list(resource="/devices/{deviceId}/artifacts", path={"deviceId": DEVICE},
                              query={"type": "firmware"})
        self.assertEqual(set(artifacts), {FIRMWARE, LEGACY_FIRMWARE})
        self.assertEqual(artifacts[FIRMWARE]["reverseEngineeringStatus"], "in_progress")
        self.assertEqual(artifacts[LEGACY_FIRMWARE]["reverseEngineeringStatus"], "not_started")
        self.assertEqual(artifacts[FIRMWARE]["status"], "ready")

    def test_general_listing_omits_field_for_non_firmware(self):
        artifacts = self.list(resource="/artifacts")
        self.assertEqual(set(artifacts), {FIRMWARE, LEGACY_FIRMWARE, PCAP})
        self.assertNotIn("reverseEngineeringStatus", artifacts[PCAP])
        self.assertEqual(artifacts[LEGACY_FIRMWARE]["reverseEngineeringStatus"], "not_started")

    def test_type_filter_unchanged(self):
        artifacts = self.list(resource="/artifacts", query={"type": "pcap"})
        self.assertEqual(set(artifacts), {PCAP})

    def test_get_artifact(self):
        for artifact_id, expected in ((FIRMWARE, "in_progress"), (LEGACY_FIRMWARE, "not_started")):
            resp = self.get_module.handler(
                event(resource="/artifacts/{artifactId}", path={"artifactId": artifact_id}), None
            )
            self.assertEqual(resp["statusCode"], 200)
            self.assertEqual(response_body(resp)["artifact"]["reverseEngineeringStatus"], expected)

        resp = self.get_module.handler(event(resource="/artifacts/{artifactId}", path={"artifactId": PCAP}), None)
        self.assertNotIn("reverseEngineeringStatus", response_body(resp)["artifact"])

    def test_download_unchanged(self):
        resp = self.get_module.handler(
            event(resource="/artifacts/{artifactId}/download", path={"artifactId": FIRMWARE}), None
        )
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["url"], "https://download")


# --- PATCH /artifacts/{artifactId} --------------------------------------------------


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("artifacts-update")
        self.table = FakeTable(standard_rows())
        self.module.dynamodb = FakeResource(self.table)

    def patch(self, body, artifact_id=FIRMWARE, user=USER):
        return self.module.handler(
            event(user=user, body=body, resource="/artifacts/{artifactId}", path={"artifactId": artifact_id}), None
        )

    def stored(self, artifact_id=FIRMWARE):
        return self.table.items[(f"ARTIFACT#{artifact_id}", "METADATA")]

    def test_transitions_between_all_values(self):
        for status in ("complete", "not_started", "in_progress", "complete"):
            with self.subTest(status=status):
                resp = self.patch({"reverseEngineeringStatus": status})
                self.assertEqual(resp["statusCode"], 200)
                self.assertEqual(response_body(resp)["reverseEngineeringStatus"], status)
                self.assertEqual(self.stored()["reverseEngineeringStatus"], status)

    def test_legacy_firmware_without_field_can_be_set(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"}, artifact_id=LEGACY_FIRMWARE)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.stored(LEGACY_FIRMWARE)["reverseEngineeringStatus"], "complete")

    def test_upload_status_untouched(self):
        before = copy.deepcopy(self.stored())
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(response_body(resp)["status"], "ready")
        after = self.stored()
        for field in ("status", "statusUpdatedAt", "attemptId", "uploadMode", "sha256", "version"):
            self.assertEqual(after[field], before[field], field)

    def test_invalid_status_rejected(self):
        for value in ("done", "", None, 3, "In-Progress", "ready"):
            with self.subTest(value=value):
                self.assertEqual(self.patch({"reverseEngineeringStatus": value})["statusCode"], 400)
        self.assertEqual(self.patch({})["statusCode"], 400)
        self.assertEqual(self.table.update_calls, [])
        self.assertEqual(self.stored()["reverseEngineeringStatus"], "in_progress")

    def test_unknown_fields_rejected(self):
        resp = self.patch({"reverseEngineeringStatus": "complete", "status": "failed"})
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("status", response_body(resp)["error"])
        self.assertEqual(self.stored()["status"], "ready")
        self.assertEqual(self.table.update_calls, [])

    def test_non_firmware_rejected(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"}, artifact_id=PCAP)
        self.assertEqual(resp["statusCode"], 400)
        self.assertNotIn("reverseEngineeringStatus", self.stored(PCAP))
        self.assertEqual(self.table.update_calls, [])

    def test_other_user_rejected(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.stored()["reverseEngineeringStatus"], "in_progress")
        self.assertEqual(self.table.update_calls, [])

    def test_non_owner_role_rejected(self):
        self.table.items[(f"USER#{USER}", f"ARTIFACT#{FIRMWARE}")]["role"] = "viewer"
        self.assertEqual(self.patch({"reverseEngineeringStatus": "complete"})["statusCode"], 404)
        self.assertEqual(self.table.update_calls, [])

    def test_missing_artifact_rejected(self):
        self.assertEqual(self.patch({"reverseEngineeringStatus": "complete"}, artifact_id=MISSING)["statusCode"], 404)

    def test_owner_link_without_metadata_is_404_and_not_created(self):
        del self.table.items[(f"ARTIFACT#{FIRMWARE}", "METADATA")]
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 404)
        self.assertNotIn((f"ARTIFACT#{FIRMWARE}", "METADATA"), self.table.items)

    def test_metadata_deleted_between_read_and_write_is_404(self):
        real_get = self.table.get_item

        def get_then_delete(Key):
            result = real_get(Key)
            if Key["sk"] == "METADATA":
                del self.table.items[(Key["pk"], Key["sk"])]
            return result

        self.table.get_item = get_then_delete
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 404)
        self.assertNotIn((f"ARTIFACT#{FIRMWARE}", "METADATA"), self.table.items)

    def test_invalid_requests(self):
        self.assertEqual(self.patch({"reverseEngineeringStatus": "complete"}, artifact_id="nope")["statusCode"], 400)
        self.assertEqual(self.patch("{not json")["statusCode"], 400)
        self.assertEqual(self.patch("[]")["statusCode"], 400)

    def test_cors_header(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], "https://vzoniq.com")


if __name__ == "__main__":
    unittest.main()
