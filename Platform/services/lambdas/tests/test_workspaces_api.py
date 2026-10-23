"""Unit tests for workspaces-api (POST /workspaces, GET /workspaces,
GET /workspaces/{workspaceId}), with DynamoDB replaced by in-memory fakes.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import importlib.util
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")

LAMBDAS = Path(__file__).resolve().parent.parent
# The shared layer (testbed_authz), which Lambda puts on the path from /opt/python.
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
TABLE = os.environ["METADATA_TABLE_NAME"]

USER = "user-sub-1"
OTHER_USER = "user-sub-2"
WS_A = "0192b000-0000-7000-8000-00000000000a"
WS_B = "0192b000-0000-7000-8000-00000000000b"
WS_C = "0192b000-0000-7000-8000-00000000000c"
WS_GONE = "0192b000-0000-7000-8000-00000000000f"


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(method, resource, user=USER, body=None, path=None, email="ipule@example.com", verified="true"):
    claims = {"sub": user}
    if email is not None:
        claims["email"] = email
    if verified is not None:
        claims["email_verified"] = verified
    return {
        "httpMethod": method,
        "resource": resource,
        "requestContext": {"authorizer": {"claims": claims}},
        "pathParameters": path,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def response_body(resp):
    return json.loads(resp["body"])


class FakeTable:
    """Just enough of a boto3 Table for workspaces-api and testbed_authz."""

    def __init__(self, rows, page_size=None):
        self.items = {(r["pk"], r["sk"]): copy.deepcopy(r) for r in rows}
        self.page_size = page_size
        self.queries = []

    def get_item(self, Key):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def query(self, KeyConditionExpression, ScanIndexForward=True, ExclusiveStartKey=None):
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        self.queries.append((pk, prefix))
        rows = sorted(
            (copy.deepcopy(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
            key=lambda r: r["sk"], reverse=not ScanIndexForward,
        )
        if ExclusiveStartKey:
            keys = [r["sk"] for r in rows]
            rows = rows[keys.index(ExclusiveStartKey["sk"]) + 1:]
        if self.page_size and len(rows) > self.page_size:
            page = rows[:self.page_size]
            return {"Items": page, "LastEvaluatedKey": {"pk": pk, "sk": page[-1]["sk"]}}
        return {"Items": rows}


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
        keys, unprocessed = request["Keys"], {}
        if self._unprocessed_once and len(keys) > 1:
            self._unprocessed_once = False
            unprocessed = {TABLE: {**request, "Keys": keys[1:]}}
            keys = keys[:1]
        found = [copy.deepcopy(i) for k in keys if (i := self.table.items.get((k["pk"], k["sk"])))]
        return {"Responses": {TABLE: found}, "UnprocessedKeys": unprocessed}


def _deserialize(attrs):
    return {k: TypeDeserializer().deserialize(v) for k, v in (attrs or {}).items()}


# The condition expressions workspaces-api sends, evaluated against the
# current item (None if absent). Anything else fails the test loudly.
CONDITIONS = {
    None: lambda item, v, n: True,
    "attribute_not_exists(pk)": lambda item, v, n: item is None,
    "attribute_exists(pk)": lambda item, v, n: item is not None,
    "attribute_not_exists(pk) OR expiresAt <= :now":
        lambda item, v, n: item is None or ("expiresAt" in item and item["expiresAt"] <= v[":now"]),
    "#role = :owner": lambda item, v, n: item is not None and item.get(n["#role"]) == v[":owner"],
    "attribute_exists(pk) AND expiresAt = :expires AND expiresAt > :now":
        lambda item, v, n: item is not None and item.get("expiresAt") == v[":expires"]
        and item["expiresAt"] > v[":now"],
}


class FakeClient:
    """transact_write_items applied all-or-nothing to the FakeTable, with the
    per-item CancellationReasons DynamoDB returns. fail_code cancels every
    transaction with that reason instead (e.g. a conflict)."""

    def __init__(self, table, fail_code=None):
        self.table = table
        self.fail_code = fail_code
        self.calls = []

    def transact_write_items(self, TransactItems):
        self.calls.append(TransactItems)
        writes, reasons = [], []
        for t in TransactItems:
            (op, spec), = t.items()
            assert spec["TableName"] == TABLE
            if op == "Put":
                item = _deserialize(spec["Item"])
                key = (item["pk"], item["sk"])
            else:
                k = _deserialize(spec["Key"])
                key, item = (k["pk"], k["sk"]), None
            check = CONDITIONS[spec.get("ConditionExpression")]
            ok = check(self.table.items.get(key), _deserialize(spec.get("ExpressionAttributeValues")),
                       spec.get("ExpressionAttributeNames") or {})
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
            elif op == "Delete":
                self.table.items.pop(key, None)
        return {}


def workspace_rows(workspace_id, user=USER, role="owner", name="Lab", email="ipule@example.com"):
    return [
        {"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA", "entity": "workspace",
         "workspaceId": workspace_id, "name": name, "createdBy": user,
         "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00"},
        *membership_rows(workspace_id, user, role, name, email),
    ]


def membership_rows(workspace_id, user, role="member", name="Lab", email=None, invited_by=None):
    reverse = {"pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user}", "entity": "workspace-user",
               "role": role, "joinedAt": "2026-10-01T00:00:00+00:00"}
    if email:
        reverse["email"] = email
    if invited_by:
        reverse["invitedBy"] = invited_by
    return [
        {"pk": f"USER#{user}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace",
         "role": role, "name": name, "joinedAt": "2026-10-01T00:00:00+00:00"},
        reverse,
    ]


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.module = load_lambda("workspaces-api")
        self.use_table(FakeTable([]))

    def use_table(self, table, **resource_kwargs):
        self.table = table
        self.resource = FakeResource(table, **resource_kwargs)
        self.client = FakeClient(table)
        self.module.dynamodb = self.resource
        self.module.client = self.client

    def call(self, *args, **kwargs):
        return self.module.handler(event(*args, **kwargs), None)


class CreateWorkspaceTests(ApiTestCase):
    def create(self, body, **kwargs):
        return self.call("POST", "/workspaces", body=body, **kwargs)

    def test_writes_workspace_and_both_owner_rows_in_one_transaction(self):
        resp = self.create({"name": "  Healthcare IoT Testbed "})
        self.assertEqual(resp["statusCode"], 201)
        workspace = response_body(resp)["workspace"]
        wid = workspace["workspaceId"]
        self.assertRegex(wid, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        self.assertEqual(workspace["name"], "Healthcare IoT Testbed")
        self.assertEqual(workspace["role"], "owner")
        self.assertEqual(workspace["createdBy"], USER)

        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.client.calls[0]), 3)
        self.assertEqual(set(self.table.items), {
            (f"WORKSPACE#{wid}", "METADATA"),
            (f"USER#{USER}", f"WORKSPACE#{wid}"),
            (f"WORKSPACE#{wid}", f"USER#{USER}"),
        })
        meta = self.table.items[(f"WORKSPACE#{wid}", "METADATA")]
        self.assertEqual(meta["entity"], "workspace")
        self.assertEqual(meta["workspaceId"], wid)
        self.assertEqual(meta["createdAt"], meta["updatedAt"])
        forward = self.table.items[(f"USER#{USER}", f"WORKSPACE#{wid}")]
        self.assertEqual((forward["entity"], forward["role"], forward["name"]),
                         ("user-workspace", "owner", "Healthcare IoT Testbed"))
        reverse = self.table.items[(f"WORKSPACE#{wid}", f"USER#{USER}")]
        self.assertEqual((reverse["entity"], reverse["role"], reverse["email"]),
                         ("workspace-user", "owner", "ipule@example.com"))
        self.assertNotIn("invitedBy", reverse)
        self.assertEqual(forward["joinedAt"], meta["createdAt"])

    def test_creator_is_always_owner(self):
        for extra in ({"role": "member"}, {"role": "owner"}, {"createdBy": OTHER_USER}, {"workspaceId": WS_A}):
            with self.subTest(extra=extra):
                resp = self.create({"name": "Lab", **extra})
                self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

        resp = self.create({"name": "Lab"})
        wid = response_body(resp)["workspace"]["workspaceId"]
        self.assertEqual(self.table.items[(f"USER#{USER}", f"WORKSPACE#{wid}")]["role"], "owner")
        self.assertEqual(self.table.items[(f"WORKSPACE#{wid}", f"USER#{USER}")]["role"], "owner")

    def test_invalid_names_rejected(self):
        for name in (None, "", "   ", 7, ["Lab"], {"n": 1}, "x" * 101, "Lab\nTeam", "Lab\tTeam", "Lab\x00", "Lab\x7f"):
            with self.subTest(name=name):
                self.assertEqual(self.create({"name": name})["statusCode"], 400)
        self.assertEqual(self.create({})["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_name_length_limit(self):
        self.assertEqual(self.create({"name": "x" * 100})["statusCode"], 201)

    def test_unknown_fields_rejected(self):
        resp = self.create({"name": "Lab", "description": "x"})
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("description", response_body(resp)["error"])
        self.assertEqual(self.client.calls, [])

    def test_invalid_json_rejected(self):
        for body in ("{not json", "[]", '"Lab"'):
            with self.subTest(body=body):
                self.assertEqual(self.create(body)["statusCode"], 400)

    def test_email_only_stored_when_verified(self):
        for kwargs in ({"verified": "false"}, {"verified": None}, {"email": None}, {"email": "  "}):
            with self.subTest(**kwargs):
                self.use_table(FakeTable([]))
                wid = response_body(self.create({"name": "Lab"}, **kwargs))["workspace"]["workspaceId"]
                self.assertNotIn("email", self.table.items[(f"WORKSPACE#{wid}", f"USER#{USER}")])

    def test_email_is_normalized(self):
        wid = response_body(self.create({"name": "Lab"}, email=" Ipule@Example.COM "))["workspace"]["workspaceId"]
        self.assertEqual(self.table.items[(f"WORKSPACE#{wid}", f"USER#{USER}")]["email"], "ipule@example.com")

    def test_failed_transaction_leaves_nothing(self):
        self.client.fail_code = "ConditionalCheckFailed"
        resp = self.create({"name": "Lab"})
        self.assertEqual(resp["statusCode"], 500)
        self.assertEqual(self.table.items, {})

    def test_each_create_gets_a_new_workspace(self):
        first = response_body(self.create({"name": "Lab"}))["workspace"]["workspaceId"]
        second = response_body(self.create({"name": "Lab"}))["workspace"]["workspaceId"]
        self.assertNotEqual(first, second)


class AuthTests(ApiTestCase):
    def test_missing_claims_are_unauthorized(self):
        for request_context in ({}, {"authorizer": None}, {"authorizer": {"claims": {}}},
                                {"authorizer": {"claims": {"sub": ""}}}):
            with self.subTest(request_context=request_context):
                for method, resource in (("POST", "/workspaces"), ("GET", "/workspaces"),
                                         ("GET", "/workspaces/{workspaceId}"), ("GET", "/invites"),
                                         ("POST", "/workspaces/{workspaceId}/invites"),
                                         ("POST", "/workspaces/{workspaceId}/accept"),
                                         ("POST", "/workspaces/{workspaceId}/decline")):
                    resp = self.module.handler({
                        "httpMethod": method, "resource": resource, "requestContext": request_context,
                        "pathParameters": {"workspaceId": WS_A}, "body": json.dumps({"name": "Lab"}),
                    }, None)
                    self.assertEqual(resp["statusCode"], 401)
        self.assertEqual(self.client.calls, [])

    def test_unknown_route(self):
        self.assertEqual(self.call("DELETE", "/workspaces/{workspaceId}", path={"workspaceId": WS_A})["statusCode"], 404)

    def test_cors_header(self):
        for resp in (self.call("POST", "/workspaces", body={"name": "Lab"}),
                     self.call("GET", "/workspaces"),
                     self.call("GET", "/workspaces/{workspaceId}", path={"workspaceId": WS_A}),
                     self.call("POST", "/workspaces", body={})):
            self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], "https://vzoniq.com")


class ListWorkspacesTests(ApiTestCase):
    def list(self, user=USER):
        resp = self.call("GET", "/workspaces", user=user)
        self.assertEqual(resp["statusCode"], 200)
        return response_body(resp)["workspaces"]

    def test_only_callers_memberships_are_queried(self):
        self.use_table(FakeTable(workspace_rows(WS_A) + workspace_rows(WS_B, user=OTHER_USER)))
        workspaces = self.list()
        self.assertEqual([w["workspaceId"] for w in workspaces], [WS_A])
        self.assertEqual(self.table.queries, [(f"USER#{USER}", "WORKSPACE#")])
        self.assertEqual({k["pk"] for r in self.resource.batch_requests for k in r["Keys"]}, {f"WORKSPACE#{WS_A}"})

    def test_returns_metadata_not_copied_name(self):
        rows = workspace_rows(WS_A, name="New name")
        rows[1]["name"] = "Old name"  # stale copy on USER#/WORKSPACE#
        self.use_table(FakeTable(rows))
        self.assertEqual(self.list(), [{
            "workspaceId": WS_A, "name": "New name", "createdBy": USER,
            "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
            "role": "owner",
        }])

    def test_includes_callers_role(self):
        rows = workspace_rows(WS_A) + workspace_rows(WS_B, user=OTHER_USER) + membership_rows(WS_B, USER, "member")
        self.use_table(FakeTable(rows))
        self.assertEqual({w["workspaceId"]: w["role"] for w in self.list()}, {WS_A: "owner", WS_B: "member"})

    def test_newest_first(self):
        self.use_table(FakeTable(workspace_rows(WS_A) + workspace_rows(WS_B)))
        self.assertEqual([w["workspaceId"] for w in self.list()], [WS_B, WS_A])

    def test_dangling_membership_is_skipped(self):
        rows = workspace_rows(WS_A) + membership_rows(WS_GONE, USER, "owner")
        self.use_table(FakeTable(rows))
        self.assertEqual([w["workspaceId"] for w in self.list()], [WS_A])

    def test_unknown_role_is_skipped(self):
        rows = workspace_rows(WS_A) + workspace_rows(WS_B, role="admin")
        self.use_table(FakeTable(rows))
        self.assertEqual([w["workspaceId"] for w in self.list()], [WS_A])

    def test_no_workspaces(self):
        self.assertEqual(self.list(), [])
        self.assertEqual(self.resource.batch_requests, [])

    def test_reads_every_query_page(self):
        ids = [f"0192b000-0000-7000-8000-{n:012x}" for n in range(1, 8)]
        rows = [r for wid in ids for r in workspace_rows(wid)]
        self.use_table(FakeTable(rows, page_size=3))
        self.assertEqual(len(self.list()), 7)

    def test_batches_of_100_and_retries_unprocessed(self):
        ids = [f"0192b000-0000-7000-8000-{n:012x}" for n in range(1, 151)]
        rows = [r for wid in ids for r in workspace_rows(wid)]
        self.use_table(FakeTable(rows), unprocessed_once=True)
        self.assertEqual(len(self.list()), 150)
        sizes = [len(r["Keys"]) for r in self.resource.batch_requests]
        self.assertEqual(sizes[0], 100)
        self.assertEqual(sum(sizes), 150 + 99)  # one retry of the 99 unprocessed keys

    def test_created_workspace_is_listed(self):
        wid = response_body(self.call("POST", "/workspaces", body={"name": "Lab"}))["workspace"]["workspaceId"]
        self.assertEqual([(w["workspaceId"], w["role"]) for w in self.list()], [(wid, "owner")])
        self.assertEqual(self.list(user=OTHER_USER), [])


class GetWorkspaceTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        rows = (
            workspace_rows(WS_A, name="Lab")
            + membership_rows(WS_A, OTHER_USER, "member", email="justin@example.com", invited_by=USER)
            + workspace_rows(WS_B, user=OTHER_USER, name="Other")
            # Rows in the same partition that aren't members, and a future
            # invitation row, must not show up as members.
            + [{"pk": f"WORKSPACE#{WS_A}", "sk": "DEVICE#11111111-1111-4111-8111-111111111111",
                "entity": "workspace-device", "name": "Pump"},
               {"pk": f"WORKSPACE#{WS_A}", "sk": "INVITE#nathan@example.com", "entity": "workspace-invite"}]
        )
        self.use_table(FakeTable(rows))

    def get(self, workspace_id=WS_A, user=USER):
        return self.call("GET", "/workspaces/{workspaceId}", user=user, path={"workspaceId": workspace_id})

    def test_member_gets_workspace_and_members(self):
        resp = self.get(user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 200)
        body = response_body(resp)
        self.assertEqual(body["workspace"], {
            "workspaceId": WS_A, "name": "Lab", "createdBy": USER,
            "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
            "role": "member",
        })
        self.assertEqual(body["members"], [
            {"userId": USER, "role": "owner", "email": "ipule@example.com",
             "joinedAt": "2026-10-01T00:00:00+00:00", "invitedBy": None},
            {"userId": OTHER_USER, "role": "member", "email": "justin@example.com",
             "joinedAt": "2026-10-01T00:00:00+00:00", "invitedBy": USER},
        ])

    def test_owner_sees_owner_role(self):
        self.assertEqual(response_body(self.get())["workspace"]["role"], "owner")

    def test_only_member_rows_of_this_workspace_are_returned(self):
        members = response_body(self.get())["members"]
        self.assertEqual({m["userId"] for m in members}, {USER, OTHER_USER})
        self.assertIn((f"WORKSPACE#{WS_A}", "USER#"), self.table.queries)
        for member in members:
            self.assertEqual(set(member), {"userId", "role", "email", "joinedAt", "invitedBy"})

    def test_non_member_gets_404_without_details(self):
        resp = self.get(workspace_id=WS_B, user=USER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Workspace not found"})
        self.assertEqual(self.table.queries, [])

    def test_non_member_and_missing_workspace_look_the_same(self):
        self.assertEqual(response_body(self.get(workspace_id=WS_B)), response_body(self.get(workspace_id=WS_GONE)))

    def test_reverse_row_alone_does_not_grant_access(self):
        # Membership is the USER#/WORKSPACE# row; WORKSPACE#/USER# is only for listing members.
        del self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WS_A}")]
        self.assertEqual(self.get(user=OTHER_USER)["statusCode"], 404)

    def test_unknown_role_is_denied(self):
        self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WS_A}")]["role"] = "admin"
        self.assertEqual(self.get(user=OTHER_USER)["statusCode"], 404)

    def test_dangling_membership_is_404(self):
        self.table.items.update({(r["pk"], r["sk"]): r for r in membership_rows(WS_GONE, USER, "owner")})
        self.assertEqual(self.get(workspace_id=WS_GONE)["statusCode"], 404)

    def test_malformed_workspace_id_rejected(self):
        for bad in (None, "", "nope", WS_A.upper(), f"{WS_A}#x", f"WORKSPACE#{WS_A}"):
            with self.subTest(workspace_id=bad):
                resp = self.call("GET", "/workspaces/{workspaceId}", path={"workspaceId": bad} if bad is not None else None)
                self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(self.table.queries, [])

    def test_reads_every_member_page(self):
        rows = workspace_rows(WS_A)
        for n in range(7):
            rows += membership_rows(WS_A, f"user-{n}")
        self.use_table(FakeTable(rows, page_size=3))
        self.assertEqual(len(response_body(self.get())["members"]), 8)

    def test_created_workspace_round_trip(self):
        self.use_table(FakeTable([]))
        created = response_body(self.call("POST", "/workspaces", body={"name": "Lab"}))["workspace"]
        body = response_body(self.get(workspace_id=created["workspaceId"]))
        self.assertEqual(body["workspace"], created)
        self.assertEqual([(m["userId"], m["role"]) for m in body["members"]], [(USER, "owner")])
        self.assertEqual(self.get(workspace_id=created["workspaceId"], user=OTHER_USER)["statusCode"], 404)


# --- Invitations --------------------------------------------------------------------
#
# USER (ipule@) owns WS_A, OTHER_USER (justin@) is invited, THIRD_USER
# (nathan@) is an existing member where a test needs one.

THIRD_USER = "user-sub-3"
OWNER_EMAIL = "ipule@example.com"
JUSTIN = "justin@example.com"
NATHAN = "nathan@example.com"
EXPIRED = -timedelta(hours=1)


def ts(delta):
    return (datetime.now(timezone.utc) + delta).isoformat(timespec="microseconds")


def invite_rows(workspace_id, email, expires_in=timedelta(days=7), invited_by=USER,
                invited_by_email=OWNER_EMAIL, workspace_name="Lab", role="member"):
    common = {"invitedBy": invited_by, "createdAt": ts(expires_in - timedelta(days=14)), "expiresAt": ts(expires_in)}
    if invited_by_email:
        common["invitedByEmail"] = invited_by_email
    return [
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"INVITE#{email}", "entity": "workspace-invite",
         "email": email, "role": role, **common},
        {"pk": f"INVITEE#{email}", "sk": f"WORKSPACE#{workspace_id}", "entity": "invitee-workspace",
         "workspaceName": workspace_name, **common},
    ]


def invite_keys(workspace_id, email):
    return {(f"WORKSPACE#{workspace_id}", f"INVITE#{email}"), (f"INVITEE#{email}", f"WORKSPACE#{workspace_id}")}


def membership_keys(workspace_id, user):
    return {(f"USER#{user}", f"WORKSPACE#{workspace_id}"), (f"WORKSPACE#{workspace_id}", f"USER#{user}")}


class InviteTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.use_table(FakeTable(
            workspace_rows(WS_A) + membership_rows(WS_A, THIRD_USER, "member", email=NATHAN, invited_by=USER)
        ))

    def invite(self, email=JUSTIN, user=USER, body=None, claim_email=OWNER_EMAIL, verified="true", workspace_id=WS_A):
        return self.call("POST", "/workspaces/{workspaceId}/invites", user=user,
                         body=body if body is not None else {"email": email},
                         path={"workspaceId": workspace_id}, email=claim_email, verified=verified)

    def invite_rows_present(self, email=JUSTIN):
        return invite_keys(WS_A, email) & set(self.table.items)

    def test_owner_can_invite(self):
        resp = self.invite()
        self.assertEqual(resp["statusCode"], 201)
        invite = self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]
        invitee = self.table.items[(f"INVITEE#{JUSTIN}", f"WORKSPACE#{WS_A}")]
        self.assertEqual(
            {k: invite[k] for k in ("entity", "email", "role", "invitedBy", "invitedByEmail")},
            {"entity": "workspace-invite", "email": JUSTIN, "role": "member",
             "invitedBy": USER, "invitedByEmail": OWNER_EMAIL},
        )
        self.assertEqual(
            {k: invitee[k] for k in ("entity", "workspaceName", "invitedBy", "invitedByEmail")},
            {"entity": "invitee-workspace", "workspaceName": "Lab", "invitedBy": USER, "invitedByEmail": OWNER_EMAIL},
        )
        self.assertNotIn("email", invitee)
        for field in ("createdAt", "expiresAt"):
            self.assertEqual(invite[field], invitee[field])
        lifetime = datetime.fromisoformat(invite["expiresAt"]) - datetime.fromisoformat(invite["createdAt"])
        self.assertEqual(lifetime, timedelta(days=14))
        self.assertEqual(response_body(resp)["invite"], {
            "email": JUSTIN, "role": "member", "invitedBy": USER, "invitedByEmail": OWNER_EMAIL,
            "createdAt": invite["createdAt"], "expiresAt": invite["expiresAt"],
        })

    def test_both_rows_written_in_one_transaction_with_owner_recheck(self):
        self.invite()
        self.assertEqual(len(self.client.calls), 1)
        ops = [next(iter(t)) for t in self.client.calls[0]]
        self.assertEqual(ops, ["ConditionCheck", "Put", "Put"])
        check = self.client.calls[0][0]["ConditionCheck"]
        self.assertEqual(_deserialize(check["Key"]), {"pk": f"USER#{USER}", "sk": f"WORKSPACE#{WS_A}"})

    def test_member_cannot_invite(self):
        resp = self.invite(user=THIRD_USER, claim_email=NATHAN)
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.client.calls, [])

    def test_non_member_cannot_invite(self):
        resp = self.invite(user="user-sub-9", claim_email="stranger@example.com")
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Workspace not found"})
        self.assertEqual(self.client.calls, [])

    def test_self_invite_rejected(self):
        for email in (OWNER_EMAIL, "  IPULE@Example.com "):
            with self.subTest(email=email):
                self.assertEqual(self.invite(email)["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_email_normalized(self):
        self.assertEqual(self.invite("  Justin@Example.COM ")["statusCode"], 201)
        self.assertEqual(self.invite_rows_present(), invite_keys(WS_A, JUSTIN))
        self.assertEqual(self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]["email"], JUSTIN)

    def test_invalid_email_rejected(self):
        for email in (None, "", "   ", 7, ["a@b.co"], "justin", "justin@", "@example.com", "justin@example",
                      "jus tin@example.com", "justin@exa mple.com", "a@b@example.com",
                      "justin@exam\x01ple.com", "jus\ttin@example.com", "x" * 250 + "@example.com"):
            with self.subTest(email=email):
                self.assertEqual(self.invite(body={"email": email})["statusCode"], 400)
        self.assertEqual(self.invite(body={})["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_client_controlled_fields_rejected(self):
        for extra in ({"role": "owner"}, {"role": "member"}, {"invitedBy": THIRD_USER},
                      {"expiresAt": "2099-01-01T00:00:00+00:00"}, {"workspaceId": WS_B}):
            with self.subTest(extra=extra):
                self.assertEqual(self.invite(body={"email": JUSTIN, **extra})["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_duplicate_active_invite_rejected(self):
        self.assertEqual(self.invite()["statusCode"], 201)
        before = copy.deepcopy(self.table.items)
        self.assertEqual(self.invite("JUSTIN@example.com")["statusCode"], 409)
        self.assertEqual(self.table.items, before)

    def test_concurrent_duplicate_is_caught_by_the_transaction(self):
        # Another request wrote the invitation after this one's pending check.
        self.table.items.update({(r["pk"], r["sk"]): r for r in invite_rows(WS_A, JUSTIN)})
        before = copy.deepcopy(self.table.items)
        with mock.patch.object(self.module, "_pending_invites", return_value=[]):
            resp = self.invite()
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.table.items, before)

    def test_expired_invite_can_be_replaced(self):
        old = invite_rows(WS_A, JUSTIN, expires_in=EXPIRED, invited_by=THIRD_USER)
        self.table.items.update({(r["pk"], r["sk"]): r for r in old})
        self.assertEqual(self.invite()["statusCode"], 201)
        invite = self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]
        invitee = self.table.items[(f"INVITEE#{JUSTIN}", f"WORKSPACE#{WS_A}")]
        self.assertGreater(datetime.fromisoformat(invite["expiresAt"]), datetime.now(timezone.utc))
        self.assertEqual((invite["invitedBy"], invitee["invitedBy"]), (USER, USER))
        self.assertEqual(invite["expiresAt"], invitee["expiresAt"])

    def test_existing_member_cannot_be_invited(self):
        self.assertEqual(self.invite("Nathan@Example.com")["statusCode"], 409)
        self.assertEqual(self.client.calls, [])

    def test_invitation_cap(self):
        for n in range(50):
            self.table.items.update({(r["pk"], r["sk"]): r for r in invite_rows(WS_A, f"p{n}@example.com")})
        resp = self.invite()
        self.assertEqual(resp["statusCode"], 409)
        self.assertIn("50", response_body(resp)["error"])
        self.assertEqual(self.invite_rows_present(), set())

    def test_expired_invites_do_not_count_toward_the_cap(self):
        for n in range(49):
            self.table.items.update({(r["pk"], r["sk"]): r for r in invite_rows(WS_A, f"p{n}@example.com")})
        for n in range(10):
            self.table.items.update({(r["pk"], r["sk"]): r
                                     for r in invite_rows(WS_A, f"old{n}@example.com", expires_in=EXPIRED)})
        self.assertEqual(self.invite()["statusCode"], 201)

    def test_owner_check_is_repeated_in_the_transaction(self):
        real = self.module.testbed_authz.require_member

        def demoted_after_check(table, user_id, workspace_id, roles=("owner", "member")):
            role = real(table, user_id, workspace_id, roles=roles)
            self.table.items[(f"USER#{USER}", f"WORKSPACE#{WS_A}")]["role"] = "member"
            return role

        with mock.patch.object(self.module.testbed_authz, "require_member", demoted_after_check):
            resp = self.invite()
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(self.invite_rows_present(), set())

    def test_failed_transaction_leaves_no_partial_state(self):
        for code, status in (("ThrottlingError", 500), ("TransactionConflict", 409)):
            with self.subTest(code=code):
                self.client.fail_code = code
                self.assertEqual(self.invite()["statusCode"], status)
                self.assertEqual(self.invite_rows_present(), set())

    def test_unverified_inviter_email_is_not_stored(self):
        self.assertEqual(self.invite(verified="false")["statusCode"], 201)
        for key in invite_keys(WS_A, JUSTIN):
            self.assertNotIn("invitedByEmail", self.table.items[key])

    def test_missing_workspace_metadata(self):
        del self.table.items[(f"WORKSPACE#{WS_A}", "METADATA")]
        self.assertEqual(self.invite()["statusCode"], 404)
        self.assertEqual(self.invite_rows_present(), set())

    def test_malformed_workspace_id(self):
        self.assertEqual(self.invite(workspace_id="nope")["statusCode"], 400)

    def test_invited_email_with_an_account_looks_the_same(self):
        # Whether the address has an account is never looked up: an address
        # that is (elsewhere) a user and one that isn't get the same answer.
        self.table.items.update({(r["pk"], r["sk"]): r
                                 for r in workspace_rows(WS_B, user=OTHER_USER, email=JUSTIN)})
        with_account = response_body(self.invite(JUSTIN))["invite"]
        without_account = response_body(self.invite("newperson@example.com"))["invite"]
        self.assertEqual(set(with_account), set(without_account))


class ListInvitesTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.use_table(FakeTable(
            workspace_rows(WS_A, name="Lab")
            + workspace_rows(WS_B, user=THIRD_USER, name="Other")
            + workspace_rows(WS_C, user=THIRD_USER, name="Third")
            + invite_rows(WS_A, JUSTIN)
            + invite_rows(WS_B, JUSTIN, workspace_name="Stale name", invited_by=THIRD_USER, invited_by_email=None)
            + invite_rows(WS_C, JUSTIN, expires_in=EXPIRED)
            + invite_rows(WS_GONE, JUSTIN)
            + invite_rows(WS_B, NATHAN)
        ))

    def list(self, email=JUSTIN, verified="true", user=OTHER_USER):
        return self.call("GET", "/invites", user=user, email=email, verified=verified)

    def test_lists_only_callers_unexpired_invites_for_existing_workspaces(self):
        resp = self.list()
        self.assertEqual(resp["statusCode"], 200)
        invites = response_body(resp)["invites"]
        self.assertEqual([i["workspaceId"] for i in invites], [WS_B, WS_A])
        a = self.table.items[(f"INVITEE#{JUSTIN}", f"WORKSPACE#{WS_A}")]
        self.assertEqual(invites[1], {
            "workspaceId": WS_A, "workspaceName": "Lab", "invitedBy": USER, "invitedByEmail": OWNER_EMAIL,
            "createdAt": a["createdAt"], "expiresAt": a["expiresAt"],
        })

    def test_workspace_name_comes_from_metadata(self):
        invites = {i["workspaceId"]: i for i in response_body(self.list())["invites"]}
        self.assertEqual(invites[WS_B]["workspaceName"], "Other")
        self.assertIsNone(invites[WS_B]["invitedByEmail"])

    def test_queries_only_the_callers_invitee_partition(self):
        # FakeTable has no scan(), so a Scan would fail the test outright.
        self.list()
        self.assertEqual(self.table.queries, [(f"INVITEE#{JUSTIN}", "WORKSPACE#")])
        requested = {k["pk"] for r in self.resource.batch_requests for k in r["Keys"]}
        self.assertEqual(requested, {f"WORKSPACE#{WS_A}", f"WORKSPACE#{WS_B}", f"WORKSPACE#{WS_GONE}"})

    def test_token_email_is_normalized(self):
        invites = response_body(self.list(email="  Justin@Example.COM "))["invites"]
        self.assertEqual({i["workspaceId"] for i in invites}, {WS_A, WS_B})

    def test_other_address_sees_only_its_own(self):
        invites = response_body(self.list(email=NATHAN, user=THIRD_USER))["invites"]
        self.assertEqual([i["workspaceId"] for i in invites], [WS_B])

    def test_unverified_or_missing_email_rejected(self):
        for kwargs in ({"verified": "false"}, {"verified": None}, {"email": None}, {"email": "  "}):
            with self.subTest(**kwargs):
                self.assertEqual(self.list(**kwargs)["statusCode"], 403)
        self.assertEqual(self.table.queries, [])

    def test_no_invites(self):
        self.assertEqual(response_body(self.list(email="nobody@example.com"))["invites"], [])
        self.assertEqual(self.resource.batch_requests, [])


class AcceptTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.use_table(FakeTable(workspace_rows(WS_A) + invite_rows(WS_A, JUSTIN)))

    def accept(self, user=OTHER_USER, email=JUSTIN, verified="true", body=None, workspace_id=WS_A):
        return self.call("POST", "/workspaces/{workspaceId}/accept", user=user, body=body,
                         path={"workspaceId": workspace_id}, email=email, verified=verified)

    def assert_invite_intact(self):
        self.assertEqual(invite_keys(WS_A, JUSTIN) & set(self.table.items), invite_keys(WS_A, JUSTIN))
        self.assertEqual(membership_keys(WS_A, OTHER_USER) & set(self.table.items), set())

    def test_accept_creates_membership_and_removes_invitation(self):
        resp = self.accept()
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["workspace"]["role"], "member")
        self.assertEqual(response_body(resp)["workspace"]["name"], "Lab")

        forward = self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WS_A}")]
        reverse = self.table.items[(f"WORKSPACE#{WS_A}", f"USER#{OTHER_USER}")]
        self.assertEqual({k: forward[k] for k in ("entity", "role", "name")},
                         {"entity": "user-workspace", "role": "member", "name": "Lab"})
        self.assertEqual({k: reverse[k] for k in ("entity", "role", "email", "invitedBy")},
                         {"entity": "workspace-user", "role": "member", "email": JUSTIN, "invitedBy": USER})
        self.assertEqual(forward["joinedAt"], reverse["joinedAt"])
        self.assertEqual(invite_keys(WS_A, JUSTIN) & set(self.table.items), set())

    def test_one_transaction_in_the_agreed_order(self):
        self.accept()
        self.assertEqual(len(self.client.calls), 1)
        ops = [(next(iter(t)), _deserialize(next(iter(t.values())).get("Key") or {}) or None)
               for t in self.client.calls[0]]
        self.assertEqual(ops, [
            ("ConditionCheck", {"pk": f"WORKSPACE#{WS_A}", "sk": "METADATA"}),
            ("Delete", {"pk": f"WORKSPACE#{WS_A}", "sk": f"INVITE#{JUSTIN}"}),
            ("Delete", {"pk": f"INVITEE#{JUSTIN}", "sk": f"WORKSPACE#{WS_A}"}),
            ("Put", None),
            ("Put", None),
        ])

    def test_new_member_has_access(self):
        self.accept()
        body = response_body(self.call("GET", "/workspaces/{workspaceId}", user=OTHER_USER,
                                       path={"workspaceId": WS_A}, email=JUSTIN))
        self.assertEqual(body["workspace"]["role"], "member")
        self.assertEqual({m["userId"]: m["role"] for m in body["members"]}, {USER: "owner", OTHER_USER: "member"})
        self.assertNotIn("invites", body)
        listed = response_body(self.call("GET", "/workspaces", user=OTHER_USER, email=JUSTIN))["workspaces"]
        self.assertEqual([(w["workspaceId"], w["role"]) for w in listed], [(WS_A, "member")])
        self.assertEqual(response_body(self.call("GET", "/invites", user=OTHER_USER, email=JUSTIN))["invites"], [])

    def test_role_is_always_member(self):
        self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]["role"] = "owner"
        self.assertEqual(self.accept()["statusCode"], 200)
        for key in membership_keys(WS_A, OTHER_USER):
            self.assertEqual(self.table.items[key]["role"], "member")

    def test_identity_comes_only_from_the_token(self):
        for body in ({"email": JUSTIN}, {"role": "owner"}, {"userId": THIRD_USER}):
            with self.subTest(body=body):
                self.assertEqual(self.accept(user=THIRD_USER, email=NATHAN, body=body)["statusCode"], 400)
        self.assert_invite_intact()

    def test_wrong_email_cannot_accept(self):
        resp = self.accept(user=THIRD_USER, email=NATHAN)
        self.assertEqual(resp["statusCode"], 404)
        self.assert_invite_intact()
        self.assertEqual(membership_keys(WS_A, THIRD_USER) & set(self.table.items), set())

    def test_unverified_email_cannot_accept(self):
        for kwargs in ({"verified": "false"}, {"verified": None}, {"email": None}):
            with self.subTest(**kwargs):
                self.assertEqual(self.accept(**kwargs)["statusCode"], 403)
        self.assert_invite_intact()

    def test_expired_invite_cannot_be_accepted(self):
        for key in invite_keys(WS_A, JUSTIN):
            self.table.items[key]["expiresAt"] = ts(EXPIRED)
        self.assertEqual(self.accept()["statusCode"], 410)
        self.assert_invite_intact()

    def test_sequential_double_accept(self):
        self.assertEqual(self.accept()["statusCode"], 200)
        after_first = copy.deepcopy(self.table.items)
        self.assertEqual(self.accept()["statusCode"], 404)
        self.assertEqual(self.table.items, after_first)

    def test_concurrent_double_accept(self):
        # The second request reads the same invitation and commits first; the
        # first request's transaction must then fail without writing anything.
        real = self.client.transact_write_items
        state = {}

        def other_request_wins(TransactItems):
            if "other" not in state:
                state["other"] = None
                state["other"] = self.accept()
            return real(TransactItems)

        self.client.transact_write_items = other_request_wins
        first = self.accept()
        self.assertEqual(sorted([first["statusCode"], state["other"]["statusCode"]]), [200, 409])
        self.assertEqual(membership_keys(WS_A, OTHER_USER) & set(self.table.items), membership_keys(WS_A, OTHER_USER))
        self.assertEqual(invite_keys(WS_A, JUSTIN) & set(self.table.items), set())

    def test_existing_member_cannot_accept_again(self):
        self.table.items.update({(r["pk"], r["sk"]): r
                                 for r in membership_rows(WS_A, OTHER_USER, "member", email=JUSTIN)})
        before = copy.deepcopy(self.table.items)
        self.assertEqual(self.accept()["statusCode"], 409)
        self.assertEqual(self.table.items, before)

    def test_leftover_member_row_blocks_accept_atomically(self):
        # Only the WORKSPACE#/USER# row exists, so the membership check passes
        # but the transaction's Put must fail and roll everything back.
        reverse = membership_rows(WS_A, OTHER_USER, "member")[1]
        self.table.items[(reverse["pk"], reverse["sk"])] = reverse
        self.assertEqual(self.accept()["statusCode"], 409)
        self.assertEqual(invite_keys(WS_A, JUSTIN) & set(self.table.items), invite_keys(WS_A, JUSTIN))
        self.assertNotIn((f"USER#{OTHER_USER}", f"WORKSPACE#{WS_A}"), self.table.items)

    def test_missing_invitee_row_blocks_accept_atomically(self):
        del self.table.items[(f"INVITEE#{JUSTIN}", f"WORKSPACE#{WS_A}")]
        self.assertEqual(self.accept()["statusCode"], 409)
        self.assertIn((f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}"), self.table.items)
        self.assertEqual(membership_keys(WS_A, OTHER_USER) & set(self.table.items), set())

    def test_deleted_workspace(self):
        del self.table.items[(f"WORKSPACE#{WS_A}", "METADATA")]
        self.assertEqual(self.accept()["statusCode"], 404)
        self.assert_invite_intact()

    def test_transaction_failure_leaves_invitation_intact(self):
        for code, status in (("ThrottlingError", 500), ("TransactionConflict", 409)):
            with self.subTest(code=code):
                self.client.fail_code = code
                self.assertEqual(self.accept()["statusCode"], status)
                self.assert_invite_intact()

    def test_malformed_workspace_id(self):
        self.assertEqual(self.accept(workspace_id="nope")["statusCode"], 400)
        self.assert_invite_intact()


class DeclineTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.use_table(FakeTable(workspace_rows(WS_A) + invite_rows(WS_A, JUSTIN)))

    def decline(self, user=OTHER_USER, email=JUSTIN, verified="true", body=None):
        return self.call("POST", "/workspaces/{workspaceId}/decline", user=user, body=body,
                         path={"workspaceId": WS_A}, email=email, verified=verified)

    def invite_present(self):
        return invite_keys(WS_A, JUSTIN) & set(self.table.items)

    def test_invitee_can_decline(self):
        resp = self.decline()
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp), {"declined": True, "workspaceId": WS_A})
        self.assertEqual(self.invite_present(), set())
        self.assertEqual(membership_keys(WS_A, OTHER_USER) & set(self.table.items), set())
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual([next(iter(t)) for t in self.client.calls[0]], ["Delete", "Delete"])

    def test_wrong_email_cannot_decline(self):
        for user, email in ((THIRD_USER, NATHAN), (USER, OWNER_EMAIL)):
            with self.subTest(email=email):
                self.assertEqual(self.decline(user=user, email=email)["statusCode"], 404)
        self.assertEqual(self.invite_present(), invite_keys(WS_A, JUSTIN))
        self.assertEqual(self.client.calls, [])

    def test_unverified_email_cannot_decline(self):
        self.assertEqual(self.decline(verified="false")["statusCode"], 403)
        self.assertEqual(self.invite_present(), invite_keys(WS_A, JUSTIN))

    def test_expired_invitation_can_be_declined(self):
        for key in invite_keys(WS_A, JUSTIN):
            self.table.items[key]["expiresAt"] = ts(EXPIRED)
        self.assertEqual(self.decline()["statusCode"], 200)
        self.assertEqual(self.invite_present(), set())

    def test_half_present_invitation_is_cleaned_up(self):
        del self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]
        self.assertEqual(self.decline()["statusCode"], 200)
        self.assertEqual(self.invite_present(), set())

    def test_declining_twice(self):
        self.assertEqual(self.decline()["statusCode"], 200)
        self.assertEqual(self.decline()["statusCode"], 404)

    def test_transaction_failure_leaves_invitation_intact(self):
        self.client.fail_code = "ThrottlingError"
        self.assertEqual(self.decline()["statusCode"], 500)
        self.assertEqual(self.invite_present(), invite_keys(WS_A, JUSTIN))

    def test_body_rejected(self):
        self.assertEqual(self.decline(body={"email": JUSTIN})["statusCode"], 400)
        self.assertEqual(self.invite_present(), invite_keys(WS_A, JUSTIN))


class GetWorkspaceInvitesTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.use_table(FakeTable(
            workspace_rows(WS_A)
            + membership_rows(WS_A, THIRD_USER, "member", email=NATHAN, invited_by=USER)
            + invite_rows(WS_A, JUSTIN)
            + invite_rows(WS_A, "old@example.com", expires_in=EXPIRED)
            + invite_rows(WS_B, "elsewhere@example.com")
            + [{"pk": f"WORKSPACE#{WS_A}", "sk": "DEVICE#11111111-1111-4111-8111-111111111111",
                "entity": "workspace-device", "name": "Pump"}]
        ))

    def get(self, user, email):
        resp = self.call("GET", "/workspaces/{workspaceId}", user=user, path={"workspaceId": WS_A}, email=email)
        self.assertEqual(resp["statusCode"], 200)
        return response_body(resp)

    def test_owner_sees_pending_invites(self):
        body = self.get(USER, OWNER_EMAIL)
        row = self.table.items[(f"WORKSPACE#{WS_A}", f"INVITE#{JUSTIN}")]
        self.assertEqual(body["invites"], [{
            "email": JUSTIN, "role": "member", "invitedBy": USER, "invitedByEmail": OWNER_EMAIL,
            "createdAt": row["createdAt"], "expiresAt": row["expiresAt"],
        }])

    def test_member_does_not_see_invites(self):
        body = self.get(THIRD_USER, NATHAN)
        self.assertNotIn("invites", body)
        self.assertEqual(body["workspace"]["role"], "member")

    def test_members_unchanged_and_other_rows_not_exposed(self):
        for user, email in ((USER, OWNER_EMAIL), (THIRD_USER, NATHAN)):
            with self.subTest(user=user):
                body = self.get(user, email)
                self.assertEqual({m["userId"] for m in body["members"]}, {USER, THIRD_USER})
                self.assertEqual(set(body) - {"invites"}, {"workspace", "members"})
                self.assertNotIn("Pump", json.dumps(body))
                self.assertNotIn("elsewhere@example.com", json.dumps(body))


class UnknownRouteTests(ApiTestCase):
    def test_unknown_route_is_404(self):
        self.assertEqual(self.call("GET", "/something")["statusCode"], 404)
        self.assertEqual(self.call("POST", "/invites")["statusCode"], 404)


if __name__ == "__main__":
    unittest.main()
