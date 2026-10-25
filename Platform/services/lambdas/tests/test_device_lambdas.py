"""Unit tests for the device Lambdas (create-device, list-devices,
update-device), with DynamoDB replaced by in-memory fakes.

Needs boto3 (as in the Lambda runtime), no AWS access:

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

# The expression evaluator and strict transaction fake of the cves-api tests,
# imported as a module so its test cases aren't collected here again.
import test_cves_api as cves_fakes
# The artifact tests' world (workspaces, devices, real artifacts-presign), for
# renames of devices that have artifacts.
import test_workspace_artifacts as artifact_world

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("DATA_LAKE_BUCKET", "data-lake")

LAMBDAS = Path(__file__).resolve().parent.parent
# The shared layer (testbed_authz), which Lambda puts on the path from /opt/python.
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
TABLE = os.environ["METADATA_TABLE_NAME"]

import device_fields  # noqa: E402  (from the shared layer, on the path above)

USER = "user-sub-1"
OTHER_USER = "user-sub-2"
DEVICE_A = "11111111-1111-4111-8111-111111111111"
DEVICE_B = "22222222-2222-4222-8222-222222222222"
WORKSPACE = "0192b000-0000-7000-8000-000000000001"


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(user=USER, body=None, device_id=None, query=None, resource=None):
    return {
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": {"deviceId": device_id} if device_id else None,
        "queryStringParameters": query,
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

    # No scan() on purpose: a Scan anywhere fails the test outright.

    def __init__(self, items):
        self.items = {(i["pk"], i["sk"]): dict(i) for i in items}
        self.update_calls = []
        self.queries = []

    def get_item(self, Key):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item else {}

    def query(self, KeyConditionExpression, ExclusiveStartKey=None, ConsistentRead=False):
        # Only the shape the device Lambdas use: pk = X AND begins_with(sk, Y).
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        self.queries.append((pk, prefix))
        rows = sorted(
            (dict(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
            key=lambda r: r["sk"],
        )
        return {"Items": rows}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues=None,
                    ExpressionAttributeNames=None, ReturnValues=None):
        self.update_calls.append(Key)
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        cves_fakes.assert_all_used({"ConditionExpression": ConditionExpression, "UpdateExpression": UpdateExpression,
                                    "ExpressionAttributeNames": names, "ExpressionAttributeValues": values})
        expression = cves_fakes.Expression(names, values)
        key = (Key["pk"], Key["sk"])
        current = self.items.get(key)
        if not expression.condition(ConditionExpression, current):
            raise conditional_check_failed()
        self.items[key] = expression.update(UpdateExpression, current or {"pk": key[0], "sk": key[1]})
        return {"Attributes": dict(self.items[key])}


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
        # Returns only the projected attributes, as DynamoDB does.
        names = request.get("ExpressionAttributeNames") or {}
        projected = [names.get(a.strip(), a.strip()) for a in request["ProjectionExpression"].split(",")]
        found = [
            {a: item[a] for a in projected if a in item}
            for k in keys
            if (item := self.table.items.get((k["pk"], k["sk"])))
        ]
        return {"Responses": {TABLE: found}, "UnprocessedKeys": unprocessed}


# The condition expressions create-device sends, evaluated against the
# current item (None if absent). Anything else fails the test loudly.
CONDITIONS = {
    "attribute_not_exists(pk)": lambda item, v, n: item is None,
    "attribute_exists(pk)": lambda item, v, n: item is not None,
    "#role IN (:role0, :role1)":
        lambda item, v, n: item is not None and item.get(n["#role"]) in (v[":role0"], v[":role1"]),
}


class FakeClient:
    """transact_write_items applied all-or-nothing to a FakeTable, with the
    per-item CancellationReasons DynamoDB returns. fail_code cancels every
    transaction with that reason instead."""

    def __init__(self, table, fail_code=None):
        self.table = table
        self.fail_code = fail_code
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
                key = tuple(deserialize(spec["Key"][k]) for k in ("pk", "sk"))
                item = None
            values = {k: deserialize(v) for k, v in (spec.get("ExpressionAttributeValues") or {}).items()}
            ok = CONDITIONS[spec["ConditionExpression"]](
                self.table.items.get(key), values, spec.get("ExpressionAttributeNames") or {})
            reasons.append({"Code": "None" if ok else "ConditionalCheckFailed"})
            writes.append((op, key, item))
        if self.fail_code:
            reasons = [{"Code": self.fail_code} for _ in TransactItems]
        if any(r["Code"] != "None" for r in reasons):
            raise ClientError({
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": reasons,
            }, "TransactWriteItems")
        for op, key, item in writes:
            if op == "Put":
                self.table.items[key] = item
        return {}


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
            {"deviceId": DEVICE_A, "name": "A", "type": "pump", "role": "owner",
             "reverseEngineeringStatus": "in_progress"},
            {"deviceId": DEVICE_B, "name": "B", "type": "pump", "role": "owner",
             "reverseEngineeringStatus": "complete"},
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

    def test_unknown_device_is_404(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"}, device_id=DEVICE_B)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.table.update_calls, [])

    # Hypothetical workspace device: nothing writes workspaceId yet (Stage 3A.3).

    def make_workspace_device(self):
        self.table.items[(f"DEVICE#{DEVICE_A}", "METADATA")]["workspaceId"] = WORKSPACE

    def test_workspace_member_can_update(self):
        self.make_workspace_device()
        self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WORKSPACE}")] = {
            "pk": f"USER#{OTHER_USER}", "sk": f"WORKSPACE#{WORKSPACE}", "role": "member",
        }
        resp = self.patch({"reverseEngineeringStatus": "complete"}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 200)

    def test_legacy_owner_of_workspace_device_needs_membership(self):
        self.make_workspace_device()
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])

    def test_cors_header(self):
        resp = self.patch({"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], "https://vzoniq.com")


# --- Workspace devices (Stage 3A.3) --------------------------------------------------
#
# WORKSPACE: USER is the owner, OTHER_USER a member, THIRD_USER an outsider.
# WORKSPACE_2: THIRD_USER is its only member.

THIRD_USER = "user-sub-3"
WORKSPACE_2 = "0192b000-0000-7000-8000-000000000002"
DEVICE_C = "33333333-3333-4333-8333-333333333333"


def workspace_rows(workspace_id=WORKSPACE, members=((USER, "owner"), (OTHER_USER, "member"))):
    rows = [{"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA", "entity": "workspace",
             "workspaceId": workspace_id, "name": "Lab"}]
    for user, role in members:
        rows.append({"pk": f"USER#{user}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace",
                     "role": role})
        rows.append({"pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user}", "entity": "workspace-user",
                     "role": role})
    return rows


def workspace_device_rows(device_id, workspace_id=WORKSPACE, name="Shared", re_status=None, created_by=USER):
    metadata = {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "deviceId": device_id,
                "name": name, "type": "pump", "status": "active", "workspaceId": workspace_id,
                "createdBy": created_by}
    if re_status is not None:
        metadata["reverseEngineeringStatus"] = re_status
    return [
        metadata,
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"DEVICE#{device_id}", "entity": "workspace-device",
         "name": name, "createdBy": created_by},
        {"pk": f"DEVICE#{device_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "device-workspace"},
    ]


def add_rows(table, rows):
    table.items.update({(r["pk"], r["sk"]): dict(r) for r in rows})


class WorkspaceCreateDeviceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("create-device")
        self.use_table(FakeTable(workspace_rows()))

    def use_table(self, table):
        self.table = table
        self.module.dynamodb = FakeResource(table)
        self.client = FakeClient(table)
        self.module.client = self.client

    def create(self, body, user=USER):
        return self.module.handler(event(user=user, body=body), None)

    def new_rows(self, before):
        return {k: v for k, v in self.table.items.items() if k not in before}

    def test_personal_creation_is_unchanged(self):
        # No reads at all, the same three rows and the same response as before workspaces.
        self.module.dynamodb = mock.Mock()
        before = set(self.table.items)
        resp = self.create({"name": "Pump", "type": "infusion"})
        self.module.dynamodb.Table.assert_not_called()
        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        self.assertEqual(set(body), {"deviceId", "name", "type", "status", "reverseEngineeringStatus",
                                     "dataPath", "createdAt", "updatedAt"})
        did = body["deviceId"]
        rows = self.new_rows(before)
        self.assertEqual(set(rows), {(f"DEVICE#{did}", "METADATA"), (f"USER#{USER}", f"DEVICE#{did}"),
                                     (f"DEVICE#{did}", f"USER#{USER}")})
        self.assertEqual(set(rows[(f"DEVICE#{did}", "METADATA")]), {
            "pk", "sk", "entity", "name", "type", "status", "reverseEngineeringStatus", "dataPath",
            "createdAt", "updatedAt",
        })

    def test_member_creates_workspace_device(self):
        before = set(self.table.items)
        resp = self.create({"name": " Pump ", "type": "infusion", "workspaceId": WORKSPACE}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        did = body["deviceId"]
        self.assertEqual((body["workspaceId"], body["createdBy"], body["name"]), (WORKSPACE, OTHER_USER, "Pump"))

        rows = self.new_rows(before)
        self.assertEqual(set(rows), {
            (f"DEVICE#{did}", "METADATA"),
            (f"WORKSPACE#{WORKSPACE}", f"DEVICE#{did}"),
            (f"DEVICE#{did}", f"WORKSPACE#{WORKSPACE}"),
        })
        metadata = rows[(f"DEVICE#{did}", "METADATA")]
        self.assertEqual({k: metadata[k] for k in ("entity", "deviceId", "name", "type", "status",
                                                    "reverseEngineeringStatus", "workspaceId", "createdBy")},
                         {"entity": "device", "deviceId": did, "name": "Pump", "type": "infusion",
                          "status": "active", "reverseEngineeringStatus": "not_started",
                          "workspaceId": WORKSPACE, "createdBy": OTHER_USER})
        self.assertEqual(metadata["createdAt"], metadata["updatedAt"])
        self.assertEqual(rows[(f"WORKSPACE#{WORKSPACE}", f"DEVICE#{did}")]["entity"], "workspace-device")
        self.assertEqual(rows[(f"WORKSPACE#{WORKSPACE}", f"DEVICE#{did}")]["createdBy"], OTHER_USER)
        self.assertEqual(rows[(f"DEVICE#{did}", f"WORKSPACE#{WORKSPACE}")]["entity"], "device-workspace")

    def test_workspace_device_has_no_ownership_rows(self):
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE})
        did = response_body(resp)["deviceId"]
        self.assertFalse([k for k in self.table.items if k[1] == f"DEVICE#{did}" and k[0].startswith("USER#")])
        self.assertFalse([k for k in self.table.items if k[0] == f"DEVICE#{did}" and k[1].startswith("USER#")])

    def test_owner_creates_workspace_device(self):
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}, user=USER)
        self.assertEqual(resp["statusCode"], 201)
        self.assertEqual(response_body(resp)["createdBy"], USER)

    def test_one_transaction_with_membership_recheck(self):
        self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}, user=OTHER_USER)
        self.assertEqual(len(self.client.calls), 1)
        ops = [next(iter(t)) for t in self.client.calls[0]]
        self.assertEqual(ops, ["Put", "Put", "Put", "ConditionCheck", "ConditionCheck"])

    def test_non_member_cannot_create(self):
        before = dict(self.table.items)
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}, user=THIRD_USER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Workspace not found"})
        self.assertEqual(self.table.items, before)
        self.assertEqual(self.client.calls, [])

    def test_nonexistent_workspace_rejected(self):
        # No workspace at all, and a membership row whose workspace record is gone.
        add_rows(self.table, [{"pk": f"USER#{USER}", "sk": f"WORKSPACE#{WORKSPACE_2}", "role": "owner"}])
        for workspace_id in ("0192b000-0000-7000-8000-0000000000ff", WORKSPACE_2):
            with self.subTest(workspace_id=workspace_id):
                resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": workspace_id})
                self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.client.calls, [])

    def test_unknown_membership_role_rejected(self):
        self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WORKSPACE}")]["role"] = "viewer"
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 404)

    def test_membership_removed_before_write(self):
        before = dict(self.table.items)
        real = self.module.testbed_authz.require_member

        def removed_after_check(table, user_id, workspace_id, roles=("owner", "member")):
            role = real(table, user_id, workspace_id, roles=roles)
            del self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WORKSPACE}")]
            return role

        with mock.patch.object(self.module.testbed_authz, "require_member", removed_after_check):
            resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 404)
        before.pop((f"USER#{OTHER_USER}", f"WORKSPACE#{WORKSPACE}"))
        self.assertEqual(self.table.items, before)

    def test_workspace_deleted_before_write(self):
        before = dict(self.table.items)
        real_get = self.table.get_item

        def get_then_delete(Key):
            result = real_get(Key)
            if Key == {"pk": f"WORKSPACE#{WORKSPACE}", "sk": "METADATA"}:
                del self.table.items[(Key["pk"], Key["sk"])]
            return result

        self.table.get_item = get_then_delete
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE})
        self.assertEqual(resp["statusCode"], 404)
        before.pop((f"WORKSPACE#{WORKSPACE}", "METADATA"))
        self.assertEqual(self.table.items, before)

    def test_transaction_failure_leaves_nothing(self):
        before = dict(self.table.items)
        self.client.fail_code = "ThrottlingError"
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE})
        self.assertEqual(resp["statusCode"], 500)
        self.assertEqual(self.table.items, before)

    def test_malformed_workspace_id_rejected(self):
        for workspace_id in (None, "", "nope", 7, [WORKSPACE], WORKSPACE.upper(), f"{WORKSPACE}#x",
                             f"WORKSPACE#{WORKSPACE}"):
            with self.subTest(workspace_id=workspace_id):
                resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": workspace_id})
                self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_existing_validation_still_comes_first(self):
        for body in ({"type": "infusion", "workspaceId": WORKSPACE}, {"name": "Pump", "workspaceId": WORKSPACE},
                     {"name": " ", "type": "infusion", "workspaceId": "nope"}):
            with self.subTest(body=body):
                resp = self.create(body)
                self.assertEqual(resp["statusCode"], 400)
                self.assertIn("is required", response_body(resp)["error"])
        self.assertEqual(self.create("{bad")["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_client_cannot_inject_ownership_fields(self):
        injected = {"createdBy": THIRD_USER, "role": "owner", "ownerId": THIRD_USER, "deviceId": DEVICE_A,
                    "status": "retired", "reverseEngineeringStatus": "complete", "entity": "x", "pk": "x"}
        for workspace in (None, WORKSPACE):
            with self.subTest(workspace=workspace):
                body = {"name": "Pump", "type": "infusion", **injected}
                if workspace:
                    body["workspaceId"] = workspace
                before = set(self.table.items)
                resp = self.create(body, user=OTHER_USER)
                self.assertEqual(resp["statusCode"], 201)
                did = response_body(resp)["deviceId"]
                self.assertNotEqual(did, DEVICE_A)
                rows = self.new_rows(before)
                metadata = rows[(f"DEVICE#{did}", "METADATA")]
                self.assertEqual((metadata["status"], metadata["reverseEngineeringStatus"], metadata["entity"]),
                                 ("active", "not_started", "device"))
                self.assertNotIn("role", metadata)
                self.assertNotIn("ownerId", metadata)
                if workspace:
                    self.assertEqual(metadata["createdBy"], OTHER_USER)
                else:
                    self.assertNotIn("createdBy", metadata)
                    self.assertEqual(rows[(f"USER#{OTHER_USER}", f"DEVICE#{did}")]["role"], "owner")
                for row in rows.values():
                    self.assertNotIn(THIRD_USER, json.dumps(row))


class WorkspaceListDevicesTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("list-devices")
        self.table = FakeTable(
            workspace_rows()
            + workspace_rows(WORKSPACE_2, members=((THIRD_USER, "owner"),))
            + device_rows(DEVICE_A, name="Personal", re_status="complete")
            + workspace_device_rows(DEVICE_B, re_status="in_progress")
            + workspace_device_rows(DEVICE_C, workspace_id=WORKSPACE_2, name="Other")
        )
        self.resource = FakeResource(self.table)
        self.module.dynamodb = self.resource

    def list(self, user=USER, workspace_id=None, query=None):
        if query is None and workspace_id is not None:
            query = {"workspaceId": workspace_id}
        return self.module.handler(event(user=user, query=query), None)

    def devices(self, *args, **kwargs):
        resp = self.list(*args, **kwargs)
        self.assertEqual(resp["statusCode"], 200)
        return response_body(resp)["devices"]

    def test_personal_listing_unchanged(self):
        self.assertEqual(self.devices(), [
            {"deviceId": DEVICE_A, "name": "Personal", "type": "pump", "role": "owner",
             "reverseEngineeringStatus": "complete"},
        ])
        self.assertEqual(self.table.queries, [(f"USER#{USER}", "DEVICE#")])

    def test_personal_listing_excludes_workspace_devices_even_with_a_stale_owner_row(self):
        add_rows(self.table, device_rows(DEVICE_B)[1:])  # leftover USER#/DEVICE# owner rows
        self.assertEqual([d["deviceId"] for d in self.devices()], [DEVICE_A])

    def test_member_lists_workspace_devices(self):
        resp = self.list(user=OTHER_USER, workspace_id=WORKSPACE)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp), {"workspaceId": WORKSPACE, "devices": [
            {"deviceId": DEVICE_B, "name": "Shared", "type": "pump", "role": "member",
             "reverseEngineeringStatus": "in_progress", "workspaceId": WORKSPACE},
        ]})

    def test_owner_lists_workspace_devices(self):
        devices = self.devices(user=USER, workspace_id=WORKSPACE)
        self.assertEqual([(d["deviceId"], d["role"]) for d in devices], [(DEVICE_B, "owner")])

    def test_non_member_cannot_list(self):
        resp = self.list(user=THIRD_USER, workspace_id=WORKSPACE)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Workspace not found"})
        self.assertEqual(self.table.queries, [])

    def test_nonexistent_workspace(self):
        add_rows(self.table, [{"pk": f"USER#{USER}", "sk": "WORKSPACE#0192b000-0000-7000-8000-0000000000ee",
                               "role": "owner"}])
        for workspace_id in ("0192b000-0000-7000-8000-0000000000ff", "0192b000-0000-7000-8000-0000000000ee"):
            with self.subTest(workspace_id=workspace_id):
                self.assertEqual(self.list(workspace_id=workspace_id)["statusCode"], 404)
        self.assertEqual(self.table.queries, [])

    def test_workspaces_are_isolated(self):
        self.assertEqual([d["deviceId"] for d in self.devices(user=THIRD_USER, workspace_id=WORKSPACE_2)], [DEVICE_C])
        self.assertEqual(self.list(user=USER, workspace_id=WORKSPACE_2)["statusCode"], 404)

    def test_relationship_row_alone_does_not_list_a_device(self):
        # A link to a personal device, and a link to another workspace's device:
        # METADATA decides, so neither is listed.
        add_rows(self.table, [
            {"pk": f"WORKSPACE#{WORKSPACE}", "sk": f"DEVICE#{DEVICE_A}", "entity": "workspace-device"},
            {"pk": f"WORKSPACE#{WORKSPACE}", "sk": f"DEVICE#{DEVICE_C}", "entity": "workspace-device"},
            {"pk": f"WORKSPACE#{WORKSPACE}", "sk": "DEVICE#44444444-4444-4444-8444-444444444444",
             "entity": "workspace-device"},  # no METADATA at all
        ])
        self.assertEqual([d["deviceId"] for d in self.devices(user=OTHER_USER, workspace_id=WORKSPACE)], [DEVICE_B])

    def test_queries_only_the_workspace_partition(self):
        self.devices(user=OTHER_USER, workspace_id=WORKSPACE)
        self.assertEqual(self.table.queries, [(f"WORKSPACE#{WORKSPACE}", "DEVICE#")])
        self.assertEqual(self.resource.batch_requests[0]["ExpressionAttributeNames"],
                         {"#name": "name", "#type": "type"})

    def test_name_comes_from_metadata(self):
        self.table.items[(f"WORKSPACE#{WORKSPACE}", f"DEVICE#{DEVICE_B}")]["name"] = "Stale"
        self.assertEqual(self.devices(user=OTHER_USER, workspace_id=WORKSPACE)[0]["name"], "Shared")

    def test_many_workspace_devices(self):
        for n in range(150):
            add_rows(self.table, workspace_device_rows(f"{n:08x}-0000-4000-8000-000000000000"))
        devices = self.devices(user=OTHER_USER, workspace_id=WORKSPACE)
        self.assertEqual(len(devices), 151)
        self.assertEqual([len(r["Keys"]) for r in self.resource.batch_requests], [100, 51])

    def test_malformed_workspace_id_rejected(self):
        for workspace_id in ("", "nope", WORKSPACE.upper(), f"{WORKSPACE}#x"):
            with self.subTest(workspace_id=workspace_id):
                self.assertEqual(self.list(workspace_id=workspace_id)["statusCode"], 400)
        self.assertEqual(self.table.queries, [])

    def test_other_query_parameters_keep_the_personal_list(self):
        self.assertEqual([d["deviceId"] for d in self.devices(query={"type": "pump"})], [DEVICE_A])


class WorkspaceUpdateDeviceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("update-device")
        self.table = FakeTable(
            workspace_rows()
            + workspace_rows(WORKSPACE_2, members=((THIRD_USER, "owner"),))
            + device_rows(DEVICE_A, name="Personal")
            + workspace_device_rows(DEVICE_B)
        )
        self.module.dynamodb = FakeResource(self.table)

    def patch(self, user, device_id, status="complete"):
        return self.module.handler(
            event(user=user, body={"reverseEngineeringStatus": status}, device_id=device_id), None)

    def status(self, device_id):
        return self.table.items[(f"DEVICE#{device_id}", "METADATA")].get("reverseEngineeringStatus")

    def test_legacy_owner_updates_personal_device(self):
        self.assertEqual(self.patch(USER, DEVICE_A)["statusCode"], 200)
        self.assertEqual(self.status(DEVICE_A), "complete")

    def test_workspace_member_cannot_update_someone_elses_personal_device(self):
        self.assertEqual(self.patch(OTHER_USER, DEVICE_A)["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])

    def test_workspace_member_updates_workspace_device(self):
        resp = self.patch(OTHER_USER, DEVICE_B)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["reverseEngineeringStatus"], "complete")
        self.assertEqual(self.status(DEVICE_B), "complete")
        self.assertEqual(self.table.items[(f"DEVICE#{DEVICE_B}", "METADATA")]["workspaceId"], WORKSPACE)

    def test_workspace_owner_updates_workspace_device(self):
        self.assertEqual(self.patch(USER, DEVICE_B, "in_progress")["statusCode"], 200)
        self.assertEqual(self.status(DEVICE_B), "in_progress")

    def test_non_member_cannot_update_workspace_device(self):
        self.assertEqual(self.patch(THIRD_USER, DEVICE_B)["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])

    def test_stale_legacy_owner_row_does_not_bypass_membership(self):
        # THIRD_USER still has old USER#/DEVICE# owner rows for D1 but is not
        # a member of its workspace.
        add_rows(self.table, device_rows(DEVICE_B, owner=THIRD_USER)[1:])
        self.assertEqual(self.patch(THIRD_USER, DEVICE_B)["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])
        self.assertNotIn("reverseEngineeringStatus", self.table.items[(f"DEVICE#{DEVICE_B}", "METADATA")])

    def test_relationship_rows_alone_do_not_make_a_workspace_device(self):
        # DEVICE_C's METADATA has no workspaceId, so it stays THIRD_USER's
        # personal device whatever WORKSPACE#/DEVICE# rows point at it.
        add_rows(self.table, device_rows(DEVICE_C, owner=THIRD_USER) + [
            {"pk": f"WORKSPACE#{WORKSPACE}", "sk": f"DEVICE#{DEVICE_C}", "entity": "workspace-device"},
            {"pk": f"DEVICE#{DEVICE_C}", "sk": f"WORKSPACE#{WORKSPACE}", "entity": "device-workspace"},
        ])
        self.assertEqual(self.patch(OTHER_USER, DEVICE_C)["statusCode"], 403)
        self.assertEqual(self.patch(USER, DEVICE_C)["statusCode"], 403)
        self.assertEqual(self.patch(THIRD_USER, DEVICE_C)["statusCode"], 200)

    def test_member_of_another_workspace_cannot_update(self):
        add_rows(self.table, workspace_device_rows(DEVICE_C, workspace_id=WORKSPACE_2))
        self.assertEqual(self.patch(OTHER_USER, DEVICE_C)["statusCode"], 403)
        self.assertEqual(self.patch(THIRD_USER, DEVICE_C)["statusCode"], 200)


class WorkspaceDeviceFlowTests(unittest.TestCase):
    """Create, list and update through the three Lambdas on one table."""

    def test_member_sees_and_updates_a_device_another_member_created(self):
        table = FakeTable(workspace_rows())
        create, listing, update = (load_lambda(n) for n in ("create-device", "list-devices", "update-device"))
        for module in (create, listing, update):
            module.dynamodb = FakeResource(table)
        create.client = FakeClient(table)

        resp = create.handler(event(user=USER, body={"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE}), None)
        did = response_body(resp)["deviceId"]

        seen = response_body(listing.handler(event(user=OTHER_USER, query={"workspaceId": WORKSPACE}), None))
        self.assertEqual([d["deviceId"] for d in seen["devices"]], [did])
        self.assertEqual(response_body(listing.handler(event(user=USER), None))["devices"], [])

        body = {"reverseEngineeringStatus": "in_progress"}
        self.assertEqual(update.handler(event(user=OTHER_USER, body=body, device_id=did), None)["statusCode"], 200)
        self.assertEqual(update.handler(event(user=THIRD_USER, body=body, device_id=did), None)["statusCode"], 403)
        self.assertEqual(listing.handler(event(user=THIRD_USER, query={"workspaceId": WORKSPACE}), None)["statusCode"], 404)


# --- Device details (manufacturer, model, ... description) ---------------------------

DETAILS = {
    "manufacturer": "Acme Medical",
    "modelNumber": "IP-200",
    "chipset": "nRF52840",
    "serialNumber": "SN-0001",
    "hardwareRevision": "rev B",
    "firmwareVersion": "2.4.1",
    "description": "Bench unit.\nUsed for BLE pairing tests.",
}
INTERNAL_FIELDS = {"pk", "sk", "entity", "dataPath", "pendingNameSync"}


def metadata_of(table, device_id):
    return table.items[(f"DEVICE#{device_id}", "METADATA")]


class DeviceFieldsTests(unittest.TestCase):
    def test_optional_values_are_trimmed(self):
        self.assertEqual(device_fields.clean_optional("chipset", "  nRF52840 \t"), "nRF52840")

    def test_empty_optional_values_are_absent(self):
        for raw in (None, "", "   ", "\n\t"):
            with self.subTest(raw=raw):
                self.assertIsNone(device_fields.clean_optional("manufacturer", raw))

    def test_optional_values_must_be_strings(self):
        for raw in (1, 0, False, [], ["a"], {"a": 1}):
            with self.subTest(raw=raw):
                with self.assertRaises(device_fields.FieldError):
                    device_fields.clean_optional("manufacturer", raw)

    def test_length_limits(self):
        for field, limit in {**device_fields.REQUIRED_FIELDS, **device_fields.OPTIONAL_FIELDS}.items():
            with self.subTest(field=field):
                clean = (device_fields.clean_required if field in device_fields.REQUIRED_FIELDS
                         else device_fields.clean_optional)
                self.assertEqual(clean(field, "x" * limit), "x" * limit)
                with self.assertRaises(device_fields.FieldError):
                    clean(field, "x" * (limit + 1))

    def test_control_characters_rejected(self):
        for field in ("name", "type", "serialNumber", "firmwareVersion"):
            for value in ("a\nb", "a\tb", "a\x00b", "a\x7fb", "a\x85b"):
                with self.subTest(field=field, value=value):
                    clean = (device_fields.clean_required if field in device_fields.REQUIRED_FIELDS
                             else device_fields.clean_optional)
                    with self.assertRaises(device_fields.FieldError):
                        clean(field, value)

    def test_description_allows_line_breaks_and_tabs_only(self):
        self.assertEqual(device_fields.clean_optional("description", "a\r\nb\tc"), "a\r\nb\tc")
        for value in ("a\x00b", "a\x1bb", "a\x7fb"):
            with self.subTest(value=value):
                with self.assertRaises(device_fields.FieldError):
                    device_fields.clean_optional("description", value)

    def test_unicode_text_is_allowed(self):
        self.assertEqual(device_fields.clean_optional("manufacturer", "Dräger · 医疗"), "Dräger · 医疗")


class CreateDeviceDetailsTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("create-device")
        self.table = FakeTable(workspace_rows())
        self.module.dynamodb = FakeResource(self.table)
        self.client = cves_fakes.FakeClient(self.table)
        self.module.client = self.client

    def create(self, body, user=USER):
        return self.module.handler(event(user=user, body=body), None)

    def test_name_and_type_alone_still_create_a_device(self):
        resp = self.create({"name": "Pump", "type": "infusion"})
        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        metadata = metadata_of(self.table, body["deviceId"])
        for field in device_fields.OPTIONAL_FIELDS:
            self.assertNotIn(field, metadata)
            self.assertNotIn(field, body)

    def test_details_are_stored_on_metadata_only(self):
        resp = self.create({"name": "Pump", "type": "infusion", **{k: f"  {v}  " for k, v in DETAILS.items()}})
        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        did = body["deviceId"]
        metadata = metadata_of(self.table, did)
        self.assertEqual({k: metadata[k] for k in DETAILS}, DETAILS)
        self.assertEqual({k: body[k] for k in DETAILS}, DETAILS)
        for key in ((f"USER#{USER}", f"DEVICE#{did}"), (f"DEVICE#{did}", f"USER#{USER}")):
            self.assertFalse(set(self.table.items[key]) & set(DETAILS))

    def test_workspace_device_with_details(self):
        resp = self.create({"name": "Pump", "type": "infusion", "workspaceId": WORKSPACE, "chipset": "ESP32"})
        self.assertEqual(resp["statusCode"], 201)
        did = response_body(resp)["deviceId"]
        self.assertEqual(metadata_of(self.table, did)["chipset"], "ESP32")
        self.assertNotIn("chipset", self.table.items[(f"WORKSPACE#{WORKSPACE}", f"DEVICE#{did}")])

    def test_empty_details_are_omitted(self):
        resp = self.create({"name": "Pump", "type": "infusion", "manufacturer": "", "modelNumber": "   ",
                            "description": None, "chipset": "ESP32"})
        self.assertEqual(resp["statusCode"], 201)
        body = response_body(resp)
        metadata = metadata_of(self.table, body["deviceId"])
        self.assertEqual({k for k in DETAILS if k in metadata}, {"chipset"})
        self.assertEqual({k for k in DETAILS if k in body}, {"chipset"})

    def test_invalid_details_rejected_and_nothing_written(self):
        before = dict(self.table.items)
        for field, value in (("manufacturer", 7), ("serialNumber", ["x"]), ("chipset", "x" * 101),
                             ("firmwareVersion", "1.0\n2"), ("description", "x" * 2001), ("modelNumber", "a\x00")):
            with self.subTest(field=field):
                resp = self.create({"name": "Pump", "type": "infusion", field: value})
                self.assertEqual(resp["statusCode"], 400)
                self.assertIn(field, response_body(resp)["error"])
        self.assertEqual(self.table.items, before)
        self.assertEqual(self.client.calls, [])

    def test_required_field_limits(self):
        self.assertEqual(self.create({"name": "x" * 256, "type": "infusion"})["statusCode"], 400)
        self.assertEqual(self.create({"name": "Pump", "type": "x" * 101})["statusCode"], 400)
        self.assertEqual(self.create({"name": "Pu\x00mp", "type": "infusion"})["statusCode"], 400)

    def test_missing_name_or_type_reported_before_details(self):
        resp = self.create({"type": "infusion", "chipset": 5})
        self.assertEqual(response_body(resp)["error"], "name is required")


class GetDeviceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("list-devices")
        self.table = FakeTable(
            workspace_rows()
            + device_rows(DEVICE_A, name="Pump", re_status="in_progress")
            + workspace_device_rows(DEVICE_B, name="Shared")
        )
        metadata_of(self.table, DEVICE_A).update(DETAILS, dataPath="s3://data-lake/devices/a/",
                                                 createdAt="2026-10-01T00:00:00+00:00",
                                                 updatedAt="2026-10-02T00:00:00+00:00")
        self.module.dynamodb = FakeResource(self.table)

    def get(self, device_id, user=USER):
        return self.module.handler(event(user=user, device_id=device_id, resource="/devices/{deviceId}"), None)

    def test_owner_reads_every_detail(self):
        resp = self.get(DEVICE_A)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp), {
            "deviceId": DEVICE_A, "name": "Pump", "type": "pump", "role": "owner", "status": "active",
            "reverseEngineeringStatus": "in_progress",
            "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-02T00:00:00+00:00",
            **DETAILS,
        })

    def test_existing_device_without_details(self):
        body = response_body(self.get(DEVICE_B, user=OTHER_USER))
        self.assertEqual(body["role"], "member")
        self.assertEqual((body["workspaceId"], body["createdBy"]), (WORKSPACE, USER))
        self.assertEqual(body["reverseEngineeringStatus"], "not_started")
        self.assertFalse(set(body) & set(DETAILS))
        self.assertFalse(set(body) & INTERNAL_FIELDS)

    def test_internal_fields_never_returned(self):
        metadata_of(self.table, DEVICE_A)["pendingNameSync"] = "Pump"
        self.assertFalse(set(response_body(self.get(DEVICE_A))) & INTERNAL_FIELDS)

    def test_outsiders_cannot_read(self):
        self.assertEqual(self.get(DEVICE_A, user=OTHER_USER)["statusCode"], 403)
        self.assertEqual(self.get(DEVICE_B, user=THIRD_USER)["statusCode"], 403)

    def test_stale_owner_row_does_not_bypass_membership(self):
        add_rows(self.table, device_rows(DEVICE_B, owner=THIRD_USER)[1:])
        self.assertEqual(self.get(DEVICE_B, user=THIRD_USER)["statusCode"], 403)

    def test_unknown_and_invalid_ids(self):
        self.assertEqual(self.get(DEVICE_C)["statusCode"], 404)
        for bad in ("nope", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", f"{DEVICE_A}#x"):
            with self.subTest(bad=bad):
                self.assertEqual(self.get(bad)["statusCode"], 400)

    def test_list_returns_type_and_details_from_metadata(self):
        self.table.items[(f"USER#{USER}", f"DEVICE#{DEVICE_A}")]["name"] = "Stale copy"
        [device] = response_body(self.module.handler(event(), None))["devices"]
        self.assertEqual(device["name"], "Pump")
        self.assertEqual(device["type"], "pump")
        self.assertEqual({k: device[k] for k in DETAILS}, DETAILS)
        self.assertFalse(set(device) & INTERNAL_FIELDS)

    def test_list_falls_back_to_the_link_name_without_metadata(self):
        del self.table.items[(f"DEVICE#{DEVICE_A}", "METADATA")]
        [device] = response_body(self.module.handler(event(), None))["devices"]
        self.assertEqual(device["name"], "Pump")


class EditDeviceTests(unittest.TestCase):
    """PATCH /devices/{deviceId} with the name, type and details."""

    def setUp(self):
        self.module = load_lambda("update-device")
        self.table = FakeTable(workspace_rows() + device_rows(DEVICE_A, name="Pump", re_status="complete")
                               + workspace_device_rows(DEVICE_B, name="Shared"))
        metadata_of(self.table, DEVICE_A).update(DETAILS)
        self.module.dynamodb = FakeResource(self.table)
        self.client = cves_fakes.FakeClient(self.table)
        self.module.client = self.client

    def patch(self, body, user=USER, device_id=DEVICE_A):
        return self.module.handler(event(user=user, body=body, device_id=device_id), None)

    def test_edit_details_without_status(self):
        resp = self.patch({"manufacturer": "  Globex ", "firmwareVersion": "3.0.0"})
        self.assertEqual(resp["statusCode"], 200)
        metadata = metadata_of(self.table, DEVICE_A)
        self.assertEqual((metadata["manufacturer"], metadata["firmwareVersion"]), ("Globex", "3.0.0"))
        self.assertEqual(metadata["chipset"], DETAILS["chipset"])
        self.assertEqual(metadata["reverseEngineeringStatus"], "complete")
        body = response_body(resp)
        self.assertEqual(body["manufacturer"], "Globex")
        self.assertEqual(body["reverseEngineeringStatus"], "complete")
        self.assertEqual(body["type"], "pump")
        # Details live on METADATA only: no copies to update.
        self.assertEqual(self.table.update_calls, [{"pk": f"DEVICE#{DEVICE_A}", "sk": "METADATA"}])
        self.assertEqual(self.client.calls, [])

    def test_edit_type(self):
        self.assertEqual(self.patch({"type": "Infusion pump"})["statusCode"], 200)
        self.assertEqual(metadata_of(self.table, DEVICE_A)["type"], "Infusion pump")
        self.assertEqual(self.client.calls, [])

    def test_clear_details_with_null_or_empty(self):
        resp = self.patch({"manufacturer": None, "chipset": "", "description": "   "})
        self.assertEqual(resp["statusCode"], 200)
        metadata = metadata_of(self.table, DEVICE_A)
        for field in ("manufacturer", "chipset", "description"):
            self.assertNotIn(field, metadata)
            self.assertNotIn(field, response_body(resp))
        self.assertEqual(metadata["serialNumber"], DETAILS["serialNumber"])

    def test_clearing_a_detail_the_device_never_had(self):
        add_rows(self.table, device_rows(DEVICE_C))
        self.assertEqual(self.patch({"chipset": None}, device_id=DEVICE_C)["statusCode"], 200)
        self.assertNotIn("chipset", metadata_of(self.table, DEVICE_C))

    def test_existing_device_without_details_or_status(self):
        add_rows(self.table, device_rows(DEVICE_C))
        resp = self.patch({"description": "Added later"}, device_id=DEVICE_C)
        self.assertEqual(resp["statusCode"], 200)
        body = response_body(resp)
        self.assertEqual(body["description"], "Added later")
        self.assertEqual(body["reverseEngineeringStatus"], "not_started")
        self.assertNotIn("reverseEngineeringStatus", metadata_of(self.table, DEVICE_C))

    def test_name_and_type_cannot_be_cleared(self):
        for body in ({"name": ""}, {"name": None}, {"type": "  "}, {"type": None}):
            with self.subTest(body=body):
                resp = self.patch(body)
                self.assertEqual(resp["statusCode"], 400)
                self.assertIn("is required", response_body(resp)["error"])
        self.assertEqual(self.table.update_calls, [])

    def test_invalid_values_rejected_and_nothing_written(self):
        before = {k: dict(v) for k, v in self.table.items.items()}
        for body in ({"chipset": 5}, {"serialNumber": "x" * 101}, {"name": "a\nb"}, {"description": "\x00"},
                     {"manufacturer": ["Acme"]}, {"chipset": "ok", "reverseEngineeringStatus": "done"}):
            with self.subTest(body=body):
                self.assertEqual(self.patch(body)["statusCode"], 400)
        self.assertEqual(self.table.items, before)

    def test_protected_fields_cannot_be_changed(self):
        for field, value in (("workspaceId", WORKSPACE), ("createdBy", OTHER_USER), ("deviceId", DEVICE_B),
                             ("pk", "DEVICE#x"), ("sk", "x"), ("entity", "x"), ("status", "retired"),
                             ("dataPath", "s3://elsewhere/"), ("createdAt", "x"), ("updatedAt", "x"),
                             ("role", "owner"), ("pendingNameSync", "x")):
            with self.subTest(field=field):
                resp = self.patch({"manufacturer": "Globex", field: value})
                self.assertEqual(resp["statusCode"], 400)
                self.assertIn(f"cannot be changed: {field}", response_body(resp)["error"])
        self.assertEqual(self.table.update_calls, [])
        self.assertNotIn("workspaceId", metadata_of(self.table, DEVICE_A))

    def test_unknown_fields_rejected(self):
        resp = self.patch({"manufacturer": "Globex", "colour": "red"})
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("Unsupported field(s): colour", response_body(resp)["error"])

    def test_empty_body_rejected(self):
        resp = self.patch({})
        self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(response_body(resp)["error"], "No fields to update")

    def test_status_and_details_together(self):
        resp = self.patch({"reverseEngineeringStatus": "in_progress", "chipset": "ESP32"})
        self.assertEqual(resp["statusCode"], 200)
        metadata = metadata_of(self.table, DEVICE_A)
        self.assertEqual((metadata["reverseEngineeringStatus"], metadata["chipset"]), ("in_progress", "ESP32"))

    def test_unauthorized_edits_are_refused(self):
        self.assertEqual(self.patch({"manufacturer": "X"}, user=OTHER_USER)["statusCode"], 403)
        self.assertEqual(self.patch({"name": "X"}, user=THIRD_USER, device_id=DEVICE_B)["statusCode"], 403)
        self.table.items[(f"USER#{USER}", f"DEVICE#{DEVICE_A}")]["role"] = "viewer"
        self.assertEqual(self.patch({"manufacturer": "X"})["statusCode"], 403)
        self.assertEqual(self.table.update_calls, [])
        self.assertEqual(self.client.calls, [])

    def test_workspace_member_edits_workspace_device(self):
        resp = self.patch({"type": "Monitor", "chipset": "ESP32"}, user=OTHER_USER, device_id=DEVICE_B)
        self.assertEqual(resp["statusCode"], 200)
        metadata = metadata_of(self.table, DEVICE_B)
        self.assertEqual((metadata["type"], metadata["chipset"]), ("Monitor", "ESP32"))
        self.assertEqual((metadata["workspaceId"], metadata["createdBy"]), (WORKSPACE, USER))
        self.assertEqual(response_body(resp)["workspaceId"], WORKSPACE)


class RenameDeviceTests(unittest.TestCase):
    """A rename rewrites every row that repeats the device's name."""

    ARTIFACT_1 = "0192d000-0000-7000-8000-000000000001"
    ARTIFACT_2 = "0192d000-0000-7000-8000-000000000002"
    CVE_1 = "0192c000-0000-7000-8000-000000000001"

    def setUp(self):
        self.module = load_lambda("update-device")
        self.module.time = mock.Mock()  # no real back-off sleeps
        self.table = FakeTable(workspace_rows() + device_rows(DEVICE_A, name="Pump")
                               + workspace_device_rows(DEVICE_B, name="Shared"))
        for device_id, name in ((DEVICE_A, "Pump"), (DEVICE_B, "Shared")):
            self.link_artifact(device_id, name, self.ARTIFACT_1, "firmware")
            self.link_artifact(device_id, name, self.ARTIFACT_2, "pcap")
            self.link_cve(device_id, name, self.CVE_1)
        self.module.dynamodb = FakeResource(self.table)
        self.client = cves_fakes.FakeClient(self.table)
        self.module.client = self.client

    def link_artifact(self, device_id, device_name, artifact_id, artifact_type):
        # As artifacts-presign writes them.
        add_rows(self.table, [
            {"pk": f"DEVICE#{device_id}", "sk": f"ARTIFACT#{artifact_type}#{artifact_id}",
             "entity": "device-artifact", "name": f"{artifact_type}.bin", "type": artifact_type},
            {"pk": f"ARTIFACT#{artifact_id}", "sk": f"DEVICE#{device_id}", "entity": "artifact-device",
             "name": device_name},
        ])

    def link_cve(self, device_id, device_name, cve_id):
        # As cves-api writes them.
        add_rows(self.table, [
            {"pk": f"DEVICE#{device_id}", "sk": f"CVE#{cve_id}", "entity": "device-cve", "cveId": "CVE-2026-0001"},
            {"pk": f"CVE#{cve_id}", "sk": f"DEVICE#{device_id}", "entity": "cve-device", "deviceName": device_name},
        ])

    def patch(self, body, user=USER, device_id=DEVICE_A):
        return self.module.handler(event(user=user, body=body, device_id=device_id), None)

    def name_copies(self, device_id):
        """Every copy of the device's name, by row key."""
        return {
            key: item.get("deviceName", item.get("name"))
            for key, item in self.table.items.items()
            if key[1] == f"DEVICE#{device_id}"
        }

    def test_rename_personal_device_updates_every_copy(self):
        before = {k: dict(v) for k, v in self.table.items.items()}
        resp = self.patch({"name": "  Infusion pump A  "})
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["name"], "Infusion pump A")
        metadata = metadata_of(self.table, DEVICE_A)
        self.assertEqual(metadata["name"], "Infusion pump A")
        self.assertNotIn("pendingNameSync", metadata)
        self.assertEqual(self.name_copies(DEVICE_A), {
            (f"USER#{USER}", f"DEVICE#{DEVICE_A}"): "Infusion pump A",
            (f"ARTIFACT#{self.ARTIFACT_1}", f"DEVICE#{DEVICE_A}"): "Infusion pump A",
            (f"ARTIFACT#{self.ARTIFACT_2}", f"DEVICE#{DEVICE_A}"): "Infusion pump A",
            (f"CVE#{self.CVE_1}", f"DEVICE#{DEVICE_A}"): "Infusion pump A",
        })
        # Nothing else changed: the associations, the artifacts' own names,
        # the other device and every other attribute of the copies.
        changed = {k for k in self.table.items if self.table.items[k] != before.get(k)}
        self.assertEqual(changed, set(self.name_copies(DEVICE_A)) | {(f"DEVICE#{DEVICE_A}", "METADATA")})
        self.assertEqual(set(self.table.items), set(before))
        self.assertEqual(self.name_copies(DEVICE_B)[(f"ARTIFACT#{self.ARTIFACT_1}", f"DEVICE#{DEVICE_B}")], "Shared")

    def test_rename_workspace_device_updates_the_workspace_row(self):
        resp = self.patch({"name": "Shared monitor"}, user=OTHER_USER, device_id=DEVICE_B)
        self.assertEqual(resp["statusCode"], 200)
        copies = self.name_copies(DEVICE_B)
        self.assertEqual(copies[(f"WORKSPACE#{WORKSPACE}", f"DEVICE#{DEVICE_B}")], "Shared monitor")
        self.assertEqual(set(copies.values()), {"Shared monitor"})
        self.assertEqual(len(copies), 4)

    def test_each_transaction_checks_the_name_first(self):
        self.patch({"name": "Renamed"})
        [items] = self.client.calls
        self.assertEqual(cves_fakes._deserialize(items[0]["ConditionCheck"]["Key"]),
                         {"pk": f"DEVICE#{DEVICE_A}", "sk": "METADATA"})
        self.assertEqual(items[0]["ConditionCheck"]["ConditionExpression"], "#name = :name")
        self.assertTrue(all(i["Update"]["ConditionExpression"] == "attribute_exists(pk)" for i in items[1:]))

    def test_many_copies_are_written_in_chunks(self):
        for n in range(250):
            self.link_artifact(DEVICE_A, "Pump", f"0192d000-0000-7000-8000-{n + 1000:012x}", "log")
        self.assertEqual(self.patch({"name": "Renamed"})["statusCode"], 200)
        # 254 copies: 99 + 99 + 56, each with the METADATA check.
        self.assertEqual([len(items) for items in self.client.calls], [100, 100, 57])
        self.assertEqual(set(self.name_copies(DEVICE_A).values()), {"Renamed"})

    def test_missing_counterpart_rows_are_skipped_not_created(self):
        del self.table.items[(f"ARTIFACT#{self.ARTIFACT_2}", f"DEVICE#{DEVICE_A}")]
        self.assertEqual(self.patch({"name": "Renamed"})["statusCode"], 200)
        self.assertNotIn((f"ARTIFACT#{self.ARTIFACT_2}", f"DEVICE#{DEVICE_A}"), self.table.items)
        self.assertEqual(set(self.name_copies(DEVICE_A).values()), {"Renamed"})
        self.assertNotIn("pendingNameSync", metadata_of(self.table, DEVICE_A))

    def test_a_later_rename_wins(self):
        # Another request renames the device after this one updated METADATA
        # but before its copies are written.
        def concurrent_rename(table):
            table.items[(f"DEVICE#{DEVICE_A}", "METADATA")].update(name="Second", pendingNameSync="Second")
        self.client.before_transact = concurrent_rename
        resp = self.patch({"name": "First"})
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["name"], "Second")
        # This request wrote no copy; the copies are the later request's to write.
        self.assertNotIn("First", self.name_copies(DEVICE_A).values())
        self.assertEqual(metadata_of(self.table, DEVICE_A)["pendingNameSync"], "Second")

    def test_failed_sync_is_finished_by_the_next_update(self):
        self.client.fail_code = "InternalServerError"
        resp = self.patch({"name": "Renamed"})
        self.assertEqual(resp["statusCode"], 500)
        self.assertIn("Save again", response_body(resp)["error"])
        metadata = metadata_of(self.table, DEVICE_A)
        self.assertEqual((metadata["name"], metadata["pendingNameSync"]), ("Renamed", "Renamed"))
        self.assertIn("Pump", self.name_copies(DEVICE_A).values())

        # Any later update, even of the status alone, completes it.
        self.client.fail_code = None
        self.assertEqual(self.patch({"reverseEngineeringStatus": "in_progress"})["statusCode"], 200)
        self.assertEqual(set(self.name_copies(DEVICE_A).values()), {"Renamed"})
        self.assertNotIn("pendingNameSync", metadata_of(self.table, DEVICE_A))

    def test_status_only_update_writes_no_copies(self):
        self.assertEqual(self.patch({"reverseEngineeringStatus": "complete"})["statusCode"], 200)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(set(self.name_copies(DEVICE_A).values()), {"Pump"})

    def test_unauthorized_rename_changes_nothing(self):
        before = {k: dict(v) for k, v in self.table.items.items()}
        self.assertEqual(self.patch({"name": "Hijacked"}, user=OTHER_USER)["statusCode"], 403)
        self.assertEqual(self.patch({"name": "Hijacked"}, user=THIRD_USER, device_id=DEVICE_B)["statusCode"], 403)
        self.assertEqual(self.table.items, before)


class RenameWithArtifactsTests(artifact_world.WorldTestCase):
    """Renames through update-device on the artifact tests' world, with
    artifacts uploaded through the real artifacts-presign."""

    def update_device(self):
        module = load_lambda("update-device")
        table = FakeTable([])
        table.items = self.table.items  # the same rows as every other Lambda here
        module.dynamodb = FakeResource(table)
        module.client = cves_fakes.FakeClient(table)
        return module

    def rename(self, user, device_id, name):
        resp = self.update_device().handler(event(user=user, body={"name": name}, device_id=device_id), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])

    def test_rename_keeps_artifact_associations(self):
        firmware = self.upload(artifact_world.USER, [artifact_world.DP])
        pcap = self.upload(artifact_world.USER, [artifact_world.DP], artifact_type="pcap")
        self.rename(artifact_world.USER, artifact_world.DP, "Renamed pump")

        # The device's artifacts are still listed for it...
        listing = self.lam("artifacts-list").handler(artifact_world.event(
            artifact_world.USER, "/devices/{deviceId}/artifacts", path={"deviceId": artifact_world.DP}), None)
        self.assertEqual(listing["statusCode"], 200, listing["body"])
        self.assertEqual({a["artifactId"] for a in response_body(listing)["artifacts"]}, {firmware, pcap})
        # ...and each artifact shows the device under its new name.
        for artifact_id in (firmware, pcap):
            resp = self.lam("artifacts-get").handler(artifact_world.event(
                artifact_world.USER, "/artifacts/{artifactId}", path={"artifactId": artifact_id}), None)
            self.assertEqual(resp["statusCode"], 200, resp["body"])
            self.assertEqual(response_body(resp)["artifact"]["devices"],
                             [{"deviceId": artifact_world.DP, "name": "Renamed pump"}])
            self.assertEqual(self.table.items[(f"ARTIFACT#{artifact_id}", "METADATA")]["deviceIds"],
                             {artifact_world.DP})
        self.assertIn((f"DEVICE#{artifact_world.DP}", "FWVER#1.0"), self.table.items)

    def test_upload_after_rename_copies_the_new_name(self):
        self.rename(artifact_world.MEMBER, artifact_world.D1, "Pump one")
        aid = self.upload(artifact_world.MEMBER, [artifact_world.D1], artifact_type="log")
        self.assertEqual(self.table.items[(f"ARTIFACT#{aid}", f"DEVICE#{artifact_world.D1}")]["name"], "Pump one")

    def test_upload_racing_a_rename_is_refused(self):
        presign = self.lam("artifacts-presign")
        resolve = presign._resolve_devices

        def resolve_then_rename(*args):
            result = resolve(*args)
            self.table.items[(f"DEVICE#{artifact_world.DP}", "METADATA")]["name"] = "Renamed meanwhile"
            return result

        with mock.patch.object(presign, "_resolve_devices", resolve_then_rename):
            resp = self.presign(artifact_world.USER, [self.file(artifact_type="log")], deviceIds=[artifact_world.DP])
        [result] = response_body(resp)["results"]
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 409)
        self.assertFalse([k for k in self.table.items
                          if k[0].startswith("ARTIFACT#") and k[1] == f"DEVICE#{artifact_world.DP}"])


if __name__ == "__main__":
    unittest.main()
