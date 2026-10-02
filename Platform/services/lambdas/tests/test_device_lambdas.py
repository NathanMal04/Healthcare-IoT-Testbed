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

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("DATA_LAKE_BUCKET", "data-lake")

LAMBDAS = Path(__file__).resolve().parent.parent
# The shared layer (testbed_authz), which Lambda puts on the path from /opt/python.
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
TABLE = os.environ["METADATA_TABLE_NAME"]

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


def event(user=USER, body=None, device_id=None, query=None):
    return {
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

    def query(self, KeyConditionExpression, ExclusiveStartKey=None):
        # Only the shape list-devices uses: pk = X AND begins_with(sk, Y).
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        self.queries.append((pk, prefix))
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
            {"deviceId": DEVICE_A, "name": "Personal", "role": "owner", "reverseEngineeringStatus": "complete"},
        ])
        self.assertEqual(self.table.queries, [(f"USER#{USER}", "DEVICE#")])

    def test_personal_listing_excludes_workspace_devices_even_with_a_stale_owner_row(self):
        add_rows(self.table, device_rows(DEVICE_B)[1:])  # leftover USER#/DEVICE# owner rows
        self.assertEqual([d["deviceId"] for d in self.devices()], [DEVICE_A])

    def test_member_lists_workspace_devices(self):
        resp = self.list(user=OTHER_USER, workspace_id=WORKSPACE)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp), {"workspaceId": WORKSPACE, "devices": [
            {"deviceId": DEVICE_B, "name": "Shared", "role": "member",
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
        self.assertEqual(self.resource.batch_requests[0]["ExpressionAttributeNames"], {"#name": "name"})

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


if __name__ == "__main__":
    unittest.main()
