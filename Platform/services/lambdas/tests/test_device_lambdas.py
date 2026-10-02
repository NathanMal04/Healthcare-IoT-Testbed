"""Unit tests for the device Lambdas (create-device, list-devices,
update-device), with DynamoDB replaced by in-memory fakes.

Needs boto3 (as in the Lambda runtime), no AWS access:

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
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
DEVICE_A = "11111111-1111-4111-8111-111111111111"
DEVICE_B = "22222222-2222-4222-8222-222222222222"


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(user=USER, body=None, device_id=None):
    return {
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": {"deviceId": device_id} if device_id else None,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def response_body(resp):
    return json.loads(resp["body"])


def conditional_check_failed():
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "failed"}}, "UpdateItem"
    )


class FakeTable:
    """Just enough of a boto3 Table for the device Lambdas."""

    def __init__(self, items):
        self.items = {(i["pk"], i["sk"]): dict(i) for i in items}
        self.update_calls = []

    def get_item(self, Key):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item else {}

    def query(self, KeyConditionExpression, ExclusiveStartKey=None):
        # Only the shape list-devices uses: pk = X AND begins_with(sk, Y).
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        rows = sorted(
            (dict(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
            key=lambda r: r["sk"],
        )
        return {"Items": rows}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues, ReturnValues):
        self.update_calls.append(Key)
        assert ConditionExpression == "attribute_exists(pk)"
        key = (Key["pk"], Key["sk"])
        if key not in self.items:
            raise conditional_check_failed()
        item = self.items[key]
        item["reverseEngineeringStatus"] = ExpressionAttributeValues[":status"]
        item["updatedAt"] = ExpressionAttributeValues[":now"]
        return {"Attributes": dict(item)}


class FakeResource:
    def __init__(self, table, unprocessed_once=False):
        self.table = table
        self.batch_requests = []
        self._unprocessed_once = unprocessed_once

    def Table(self, name):
        assert name == TABLE
        return self.table

    def batch_get_item(self, RequestItems):
        request = RequestItems[TABLE]
        self.batch_requests.append(request)
        assert len(request["Keys"]) <= 100
        keys = request["Keys"]
        unprocessed = {}
        if self._unprocessed_once and len(keys) > 1:
            # Simulate DynamoDB returning part of the batch as unprocessed.
            self._unprocessed_once = False
            unprocessed = {TABLE: {**request, "Keys": keys[1:]}}
            keys = keys[:1]
        found = [
            {"pk": k["pk"], **({"reverseEngineeringStatus": item["reverseEngineeringStatus"]}
                               if "reverseEngineeringStatus" in item else {})}
            for k in keys
            if (item := self.table.items.get((k["pk"], k["sk"])))
        ]
        return {"Responses": {TABLE: found}, "UnprocessedKeys": unprocessed}


def device_rows(device_id, owner=USER, name="Device", re_status=None, role="owner"):
    metadata = {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device",
                "name": name, "type": "pump", "status": "active"}
    if re_status is not None:
        metadata["reverseEngineeringStatus"] = re_status
    return [
        metadata,
        {"pk": f"USER#{owner}", "sk": f"DEVICE#{device_id}", "entity": "user-device", "role": role, "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"USER#{owner}", "entity": "device-user", "role": role},
    ]


class CreateDeviceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("create-device")
        self.client = mock.Mock()
        self.module.client = self.client

    def test_new_device_defaults_to_not_started(self):
        resp = self.module.handler(event(body={"name": "Pump", "type": "infusion"}), None)

        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        self.assertEqual(body["reverseEngineeringStatus"], "not_started")
        self.assertEqual(body["status"], "active")

        items = [
            {k: TypeDeserializer().deserialize(v) for k, v in t["Put"]["Item"].items()}
            for t in self.client.transact_write_items.call_args.kwargs["TransactItems"]
        ]
        by_entity = {i["entity"]: i for i in items}
        self.assertEqual(by_entity["device"]["reverseEngineeringStatus"], "not_started")
        self.assertEqual(by_entity["device"]["sk"], "METADATA")
        # The canonical status is not copied onto the relationship rows.
        self.assertNotIn("reverseEngineeringStatus", by_entity["user-device"])
        self.assertNotIn("reverseEngineeringStatus", by_entity["device-user"])


class ListDevicesTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("list-devices")

    def run_handler(self, rows, **resource_kwargs):
        self.resource = FakeResource(FakeTable(rows), **resource_kwargs)
        self.module.dynamodb = self.resource
        resp = self.module.handler(event(), None)
        self.assertEqual(resp["statusCode"], 200)
        return response_body(resp)["devices"]

    def test_returns_status_from_device_metadata(self):
        devices = self.run_handler(
            device_rows(DEVICE_A, name="A", re_status="in_progress")
            + device_rows(DEVICE_B, name="B", re_status="complete")
        )
        self.assertEqual(devices, [
            {"deviceId": DEVICE_A, "name": "A", "role": "owner", "reverseEngineeringStatus": "in_progress"},
            {"deviceId": DEVICE_B, "name": "B", "role": "owner", "reverseEngineeringStatus": "complete"},
        ])

    def test_missing_attribute_reads_as_not_started(self):
        devices = self.run_handler(device_rows(DEVICE_A))
        self.assertEqual(devices[0]["reverseEngineeringStatus"], "not_started")

    def test_missing_metadata_record_reads_as_not_started(self):
        rows = [r for r in device_rows(DEVICE_A) if r["sk"] != "METADATA"]
        devices = self.run_handler(rows)
        self.assertEqual(devices[0]["reverseEngineeringStatus"], "not_started")

    def test_status_on_link_row_is_ignored(self):
        rows = device_rows(DEVICE_A, re_status="complete")
        rows[1]["reverseEngineeringStatus"] = "in_progress"  # stray copy on USER#/DEVICE#
        devices = self.run_handler(rows)
        self.assertEqual(devices[0]["reverseEngineeringStatus"], "complete")

    def test_uses_one_batch_get_not_per_device_get(self):
        self.run_handler(device_rows(DEVICE_A) + device_rows(DEVICE_B))
        self.assertEqual(len(self.resource.batch_requests), 1)
        self.assertEqual(
            {k["pk"] for k in self.resource.batch_requests[0]["Keys"]},
            {f"DEVICE#{DEVICE_A}", f"DEVICE#{DEVICE_B}"},
        )

    def test_batches_of_100_keys(self):
        rows = []
        for n in range(150):
            rows += device_rows(f"{n:08x}-0000-4000-8000-000000000000", re_status="complete")
        devices = self.run_handler(rows)
        self.assertEqual(len(devices), 150)
        self.assertEqual([len(r["Keys"]) for r in self.resource.batch_requests], [100, 50])
        self.assertTrue(all(d["reverseEngineeringStatus"] == "complete" for d in devices))

    def test_retries_unprocessed_keys(self):
        devices = self.run_handler(
            device_rows(DEVICE_A, re_status="complete") + device_rows(DEVICE_B, re_status="in_progress"),
            unprocessed_once=True,
        )
        self.assertEqual(len(self.resource.batch_requests), 2)
        self.assertEqual(
            [d["reverseEngineeringStatus"] for d in devices], ["complete", "in_progress"]
        )

    def test_no_devices_skips_batch_get(self):
        devices = self.run_handler([])
        self.assertEqual(devices, [])
        self.assertEqual(self.resource.batch_requests, [])

    def test_only_callers_devices(self):
        devices = self.run_handler(device_rows(DEVICE_A) + device_rows(DEVICE_B, owner=OTHER_USER))
        self.assertEqual([d["deviceId"] for d in devices], [DEVICE_A])


class UpdateDeviceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("update-device")
        self.table = FakeTable(device_rows(DEVICE_A, name="Pump"))
        self.module.dynamodb = FakeResource(self.table)

    def patch(self, body, user=USER, device_id=DEVICE_A):
        return self.module.handler(event(user=user, body=body, device_id=device_id), None)

    def test_owner_can_update_each_status(self):
        for status in ("in_progress", "complete", "not_started"):
            with self.subTest(status=status):
                resp = self.patch({"reverseEngineeringStatus": status})
                self.assertEqual(resp["statusCode"], 200)
                body = response_body(resp)
                self.assertEqual(body["reverseEngineeringStatus"], status)
                self.assertEqual(body["deviceId"], DEVICE_A)
                self.assertEqual(body["name"], "Pump")
                metadata = self.table.items[(f"DEVICE#{DEVICE_A}", "METADATA")]
                self.assertEqual(metadata["reverseEngineeringStatus"], status)

    def test_only_metadata_record_is_written(self):
        self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(self.table.update_calls, [{"pk": f"DEVICE#{DEVICE_A}", "sk": "METADATA"}])
        link = self.table.items[(f"USER#{USER}", f"DEVICE#{DEVICE_A}")]
        self.assertNotIn("reverseEngineeringStatus", link)

    def test_lifecycle_status_untouched(self):
        self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(self.table.items[(f"DEVICE#{DEVICE_A}", "METADATA")]["status"], "active")

    def test_non_owner_is_forbidden(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])

    def test_non_owner_role_is_forbidden(self):
        self.table.items[(f"USER#{USER}", f"DEVICE#{DEVICE_A}")]["role"] = "viewer"
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])

    def test_invalid_status_rejected(self):
        for value in ("done", "", None, 1, "In-Progress"):
            with self.subTest(value=value):
                resp = self.patch({"reverseEngineeringStatus": value})
                self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(self.table.update_calls, [])

    def test_missing_status_rejected(self):
        self.assertEqual(self.patch({})["statusCode"], 400)

    def test_unsupported_fields_rejected(self):
        resp = self.patch({"reverseEngineeringStatus": "complete", "status": "retired"})
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("status", response_body(resp)["error"])
        self.assertEqual(self.table.update_calls, [])

    def test_invalid_json_rejected(self):
        self.assertEqual(self.patch("{not json")["statusCode"], 400)
        self.assertEqual(self.patch("[1, 2]")["statusCode"], 400)

    def test_invalid_device_id_rejected(self):
        self.assertEqual(self.patch({"reverseEngineeringStatus": "complete"}, device_id="nope")["statusCode"], 400)
        resp = self.module.handler(event(body={"reverseEngineeringStatus": "complete"}), None)
        self.assertEqual(resp["statusCode"], 400)

    def test_missing_metadata_is_404_and_not_created(self):
        del self.table.items[(f"DEVICE#{DEVICE_A}", "METADATA")]
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 404)
        self.assertNotIn((f"DEVICE#{DEVICE_A}", "METADATA"), self.table.items)

    def test_cors_header(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], "https://vzoniq.com")


if __name__ == "__main__":
    unittest.main()
