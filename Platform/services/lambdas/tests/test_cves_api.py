"""Unit tests for cves-api (POST /cves, GET /cves, GET and PATCH
/cves/{cveRecordId}), with DynamoDB replaced by in-memory fakes.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import importlib.util
import json
import os
import re
import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
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
MEMBER = "user-sub-2"
OTHER_USER = "user-sub-3"
WS_A = "0192b000-0000-7000-8000-00000000000a"
WS_B = "0192b000-0000-7000-8000-00000000000b"
CVE_P = "0192c000-0000-7000-8000-000000000001"  # personal, owned by USER
CVE_A = "0192c000-0000-7000-8000-00000000000a"  # in WS_A
CVE_B = "0192c000-0000-7000-8000-00000000000b"  # in WS_B
MISSING = "0192c000-0000-7000-8000-0000000000ff"
UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 10, 5, 13, 0, 0, tzinfo=timezone.utc)


def load_lambda(name):
    spec = importlib.util.spec_from_file_location(
        f"{name.replace('-', '_')}_lambda", LAMBDAS / name / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(method, resource, user=USER, body=None, path=None, query=None):
    return {
        "httpMethod": method,
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": path,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


def response_body(resp):
    return json.loads(resp["body"])


class FakeTable:
    """Just enough of a boto3 Table for cves-api and testbed_authz."""

    def __init__(self, rows):
        self.items = {(r["pk"], r["sk"]): copy.deepcopy(r) for r in rows}
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
        return {"Items": rows}


class FakeResource:
    def __init__(self, table):
        self.table = table
        self.batch_requests = []

    def Table(self, name):
        assert name == TABLE
        return self.table

    def batch_get_item(self, RequestItems):
        request = RequestItems[TABLE]
        self.batch_requests.append(request)
        assert len(request["Keys"]) <= 100
        found = [copy.deepcopy(i) for k in request["Keys"] if (i := self.table.items.get((k["pk"], k["sk"])))]
        return {"Responses": {TABLE: found}, "UnprocessedKeys": {}}


def _deserialize(attrs):
    return {k: TypeDeserializer().deserialize(v) for k, v in (attrs or {}).items()}


def _version_and_scope(item, v, n, workspace):
    if item is None or item.get(n["#version"]) != v[":expected"]:
        return False
    if workspace:
        return item.get(n["#workspaceId"]) == v[":workspaceId"]
    return n["#workspaceId"] not in item


# The condition expressions cves-api sends, evaluated against the current item
# (None if absent). Anything else fails the test loudly.
CONDITIONS = {
    "attribute_not_exists(pk)": lambda item, v, n: item is None,
    "attribute_exists(pk)": lambda item, v, n: item is not None,
    "#role IN (:role0, :role1)":
        lambda item, v, n: item is not None and item.get(n["#role"]) in (v[":role0"], v[":role1"]),
    "#role = :owner": lambda item, v, n: item is not None and item.get(n["#role"]) == v[":owner"],
    "attribute_exists(pk) AND #version = :expected AND #workspaceId = :workspaceId":
        lambda item, v, n: _version_and_scope(item, v, n, workspace=True),
    "attribute_exists(pk) AND #version = :expected AND attribute_not_exists(#workspaceId)":
        lambda item, v, n: _version_and_scope(item, v, n, workspace=False),
}


def apply_update(item, expression, names, values):
    """The SET/REMOVE subset of UpdateExpression that cves-api uses."""
    item = copy.deepcopy(item)
    set_part, _, remove_part = expression.partition(" REMOVE ")
    assert set_part.startswith("SET ")
    for clause in set_part[len("SET "):].split(", "):
        target, rhs = clause.split(" = ")
        if " + " in rhs:
            left, right = rhs.split(" + ")
            item[names[target]] = item[names[left]] + values[right]
        else:
            item[names[target]] = values[rhs]
    for name in filter(None, remove_part.split(", ")):
        item.pop(names[name], None)
    return item


class FakeClient:
    """transact_write_items applied all-or-nothing to the FakeTable, with the
    per-item CancellationReasons DynamoDB returns. before_transact runs first,
    to change the table between the Lambda's reads and its write."""

    def __init__(self, table, fail_code=None):
        self.table = table
        self.fail_code = fail_code
        self.calls = []
        self.before_transact = None

    def transact_write_items(self, TransactItems):
        self.calls.append(TransactItems)
        if self.before_transact:
            self.before_transact(self.table)
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
            names = spec.get("ExpressionAttributeNames") or {}
            values = _deserialize(spec.get("ExpressionAttributeValues"))
            current = self.table.items.get(key)
            ok = CONDITIONS[spec["ConditionExpression"]](current, values, names)
            reasons.append({"Code": "None" if ok else "ConditionalCheckFailed"})
            if op == "Update" and ok:
                item = apply_update(current, spec["UpdateExpression"], names, values)
            writes.append((op, key, item))
        if self.fail_code:
            reasons = [{"Code": self.fail_code} for _ in TransactItems]
        if any(r["Code"] != "None" for r in reasons):
            raise ClientError({
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": reasons,
            }, "TransactWriteItems")
        for op, key, item in writes:
            if op in ("Put", "Update"):
                self.table.items[key] = item
        return {}


def workspace_rows(workspace_id, members):
    rows = [{"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA", "entity": "workspace",
             "workspaceId": workspace_id, "name": "Lab", "createdBy": USER,
             "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00"}]
    for user, role in members.items():
        rows += [
            {"pk": f"USER#{user}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace", "role": role},
            {"pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user}", "entity": "workspace-user", "role": role},
        ]
    return rows


def cve_metadata(record_id, cve_id, workspace_id=None, created_by=USER, **fields):
    item = {"pk": f"CVE#{record_id}", "sk": "METADATA", "entity": "cve", "cveRecordId": record_id,
            "cveId": cve_id, "severity": "high", "createdBy": created_by,
            "createdAt": "2026-10-02T00:00:00.000000+00:00", "updatedAt": "2026-10-02T00:00:00.000000+00:00",
            "version": Decimal(1), **fields}
    if workspace_id:
        item["workspaceId"] = workspace_id
    return item


def personal_cve_rows(record_id, cve_id, owner=USER, **fields):
    return [
        cve_metadata(record_id, cve_id, created_by=owner, **fields),
        {"pk": f"USER#{owner}", "sk": f"CVE#{record_id}", "entity": "user-cve", "role": "owner", "cveId": cve_id},
        {"pk": f"CVE#{record_id}", "sk": f"USER#{owner}", "entity": "cve-user", "role": "owner"},
        {"pk": f"USER#{owner}", "sk": f"CVEID#{cve_id}", "entity": "cve-claim", "cveId": cve_id,
         "cveRecordId": record_id},
    ]


def workspace_cve_rows(record_id, cve_id, workspace_id, **fields):
    return [
        cve_metadata(record_id, cve_id, workspace_id, **fields),
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"CVE#{record_id}", "entity": "workspace-cve", "cveId": cve_id},
        {"pk": f"CVE#{record_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "cve-workspace"},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"CVEID#{cve_id}", "entity": "cve-claim", "cveId": cve_id,
         "cveRecordId": record_id},
    ]


class ApiTestCase(unittest.TestCase):
    rows = []

    def setUp(self):
        self.module = load_lambda("cves-api")
        self.use_table(FakeTable(self.rows))
        patcher = mock.patch.object(self.module, "_utcnow", return_value=NOW)
        self.utcnow = patcher.start()
        self.addCleanup(patcher.stop)

    def use_table(self, table):
        self.table = table
        self.resource = FakeResource(table)
        self.client = FakeClient(table)
        self.module.dynamodb = self.resource
        self.module.client = self.client

    def call(self, *args, **kwargs):
        return self.module.handler(event(*args, **kwargs), None)

    def create(self, body, user=USER):
        return self.call("POST", "/cves", user=user, body=body)

    def get(self, record_id, user=USER):
        return self.call("GET", "/cves/{cveRecordId}", user=user, path={"cveRecordId": record_id})

    def patch(self, record_id, body, user=USER):
        return self.call("PATCH", "/cves/{cveRecordId}", user=user, path={"cveRecordId": record_id}, body=body)

    def list(self, user=USER, workspace_id=None):
        query = {"workspaceId": workspace_id} if workspace_id is not None else None
        return self.call("GET", "/cves", user=user, query=query)

    def keys_with_pk_prefix(self, prefix):
        return {key for key in self.table.items if key[0].startswith(prefix)}


# --- CVE id normalization -------------------------------------------------------------

class NormalizeCveIdTests(ApiTestCase):
    def normalize(self, value):
        return self.module.normalize_cve_id(value)

    def assertRejected(self, value):
        with self.assertRaises(self.module.RequestError) as ctx:
            self.normalize(value)
        self.assertEqual(ctx.exception.status, 400)

    def test_canonical_form(self):
        cases = {
            "CVE-2021-37584": "CVE-2021-37584",
            "cve-2021-37584": "CVE-2021-37584",
            "  cve-2021-37584 \n": "CVE-2021-37584",
            "Cve-2020-26652": "CVE-2020-26652",
            "CVE-2021-1234567": "CVE-2021-1234567",
            "CVE-1999-0001": "CVE-1999-0001",
            "CVE-2027-0001": "CVE-2027-0001",  # current year + 1
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(self.normalize(raw), expected)

    def test_unicode_hyphens_become_ascii(self):
        for hyphen in [chr(cp) for cp in range(0x2010, 0x2016)] + ["−"]:
            with self.subTest(codepoint=f"U+{ord(hyphen):04X}"):
                self.assertEqual(self.normalize(f"CVE{hyphen}2021{hyphen}37584"), "CVE-2021-37584")
        self.assertEqual(self.normalize("cve–2021-37584"), "CVE-2021-37584")

    def test_invalid_format(self):
        for raw in ["", "   ", "CVE-2021", "CVE-2021-123", "CVE-21-37584", "CVE_2021_37584", "2021-37584",
                    "CVE-2021-37584x", "xCVE-2021-37584", "CVE-2021-37584\nCVE-2021-1", "CVE 2021 37584",
                    "CVE-2021-12345678901234567890", "CVE--2021-37584", "CVE-2021-37584#",
                    "CVE-2021-" + "1" * 70]:
            with self.subTest(raw=raw):
                self.assertRejected(raw)

    def test_non_string_rejected(self):
        for raw in [None, 2021, ["CVE-2021-37584"], {"id": "CVE-2021-37584"}, True]:
            with self.subTest(raw=raw):
                self.assertRejected(raw)

    def test_invalid_year(self):
        for raw in ["CVE-1998-0001", "CVE-0000-0001", "CVE-2028-0001", "CVE-9999-0001"]:
            with self.subTest(raw=raw):
                self.assertRejected(raw)

    def test_only_ascii_digits(self):
        for raw in [
            "CVE-٢٠٢١-37584",  # Arabic-Indic digits
            "CVE-2021-３７５８４",  # fullwidth digits
            "CVE-2021-٣٧٥٨٤",
            "ＣＶＥ-2021-37584",  # fullwidth letters
        ]:
            with self.subTest(raw=raw):
                self.assertRejected(raw)


# --- POST /cves ------------------------------------------------------------------------

class CreatePersonalCveTests(ApiTestCase):
    def test_writes_metadata_ownership_rows_and_claim_in_one_transaction(self):
        resp = self.create({"cveId": " cve-2021-37584 ", "severity": "high", "cvssScore": 8.2,
                            "cvssVersion": "3.1", "description": "  WPS / IEEE 1905 OOB write.  ",
                            "affectedChipsets": ["MT7610UN", "MT7612UN"],
                            "references": ["https://nvd.nist.gov/vuln/detail/CVE-2021-37584"]})
        self.assertEqual(resp["statusCode"], 201)
        cve = response_body(resp)["cve"]
        rid = cve["cveRecordId"]
        self.assertRegex(rid, UUID7)
        self.assertEqual(cve, {
            "cveRecordId": rid, "cveId": "CVE-2021-37584", "severity": "high", "cvssScore": 8.2,
            "cvssVersion": "3.1", "affectedChipsets": ["MT7610UN", "MT7612UN"], "createdBy": USER,
            "createdAt": NOW.isoformat(timespec="microseconds"),
            "updatedAt": NOW.isoformat(timespec="microseconds"), "version": 1,
            "description": "WPS / IEEE 1905 OOB write.",
            "references": ["https://nvd.nist.gov/vuln/detail/CVE-2021-37584"],
        })

        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(len(self.client.calls[0]), 4)
        self.assertEqual(set(self.table.items), {
            (f"CVE#{rid}", "METADATA"),
            (f"USER#{USER}", f"CVE#{rid}"),
            (f"CVE#{rid}", f"USER#{USER}"),
            (f"USER#{USER}", "CVEID#CVE-2021-37584"),
        })
        meta = self.table.items[(f"CVE#{rid}", "METADATA")]
        self.assertEqual(meta["entity"], "cve")
        self.assertEqual(meta["cvssScore"], Decimal("8.2"))
        self.assertEqual(meta["version"], 1)
        self.assertNotIn("workspaceId", meta)
        self.assertNotIn("deviceIds", meta)
        forward = self.table.items[(f"USER#{USER}", f"CVE#{rid}")]
        self.assertEqual((forward["entity"], forward["role"], forward["cveId"]), ("user-cve", "owner", "CVE-2021-37584"))
        reverse = self.table.items[(f"CVE#{rid}", f"USER#{USER}")]
        self.assertEqual((reverse["entity"], reverse["role"]), ("cve-user", "owner"))
        claim = self.table.items[(f"USER#{USER}", "CVEID#CVE-2021-37584")]
        self.assertEqual((claim["entity"], claim["cveRecordId"]), ("cve-claim", rid))
        # Every Put is conditional, so nothing is ever overwritten.
        for item in self.client.calls[0]:
            self.assertEqual(item["Put"]["ConditionExpression"], "attribute_not_exists(pk)")

    def test_minimal_create_leaves_optional_fields_out(self):
        resp = self.create({"cveId": "CVE-2020-26652", "severity": "medium", "description": "  ",
                            "affectedChipsets": [], "references": [], "cvssScore": None})
        self.assertEqual(resp["statusCode"], 201)
        cve = response_body(resp)["cve"]
        meta = self.table.items[(f"CVE#{cve['cveRecordId']}", "METADATA")]
        for field in ("cvssScore", "cvssVersion", "description", "affectedChipsets", "references"):
            self.assertNotIn(field, meta)
        self.assertEqual((cve["cvssScore"], cve["description"], cve["affectedChipsets"], cve["references"]),
                         (None, None, [], []))

    def test_server_owned_fields_cannot_be_supplied(self):
        for field, value in [("createdBy", OTHER_USER), ("cveRecordId", CVE_P), ("version", 7),
                             ("createdAt", "2020-01-01"), ("updatedAt", "2020-01-01"), ("deviceIds", [])]:
            with self.subTest(field=field):
                resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", field: value})
                self.assertEqual(resp["statusCode"], 400)
                self.assertIn(field, response_body(resp)["error"])
        self.assertEqual(self.client.calls, [])

    def test_bad_json(self):
        for body in ["not json", "[]", '"CVE-2021-37584"', '{"cveId": "CVE-2021-37584", "severity": "high", '
                                                            '"cvssScore": NaN}']:
            with self.subTest(body=body):
                self.assertEqual(self.create(body)["statusCode"], 400)


class CreateWorkspaceCveTests(ApiTestCase):
    rows = workspace_rows(WS_A, {USER: "owner", MEMBER: "member"})

    def test_owner_creates_workspace_cve_without_ownership_rows(self):
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})
        self.assertEqual(resp["statusCode"], 201)
        cve = response_body(resp)["cve"]
        rid = cve["cveRecordId"]
        self.assertEqual(cve["workspaceId"], WS_A)
        self.assertEqual(cve["createdBy"], USER)

        self.assertEqual(self.keys_with_pk_prefix("CVE#"), {(f"CVE#{rid}", "METADATA"),
                                                           (f"CVE#{rid}", f"WORKSPACE#{WS_A}")})
        self.assertEqual(self.table.items[(f"CVE#{rid}", "METADATA")]["workspaceId"], WS_A)
        link = self.table.items[(f"WORKSPACE#{WS_A}", f"CVE#{rid}")]
        self.assertEqual((link["entity"], link["cveId"], link["createdBy"]), ("workspace-cve", "CVE-2021-37584", USER))
        self.assertEqual(self.table.items[(f"CVE#{rid}", f"WORKSPACE#{WS_A}")]["entity"], "cve-workspace")
        claim = self.table.items[(f"WORKSPACE#{WS_A}", "CVEID#CVE-2021-37584")]
        self.assertEqual((claim["entity"], claim["cveRecordId"]), ("cve-claim", rid))
        # No USER# rows for the CVE at all: no ownership, no personal claim.
        self.assertFalse([k for k in self.table.items if k[0] == f"USER#{USER}" and "CVE" in k[1]])
        self.assertFalse([k for k in self.table.items if k[0] == f"CVE#{rid}" and k[1].startswith("USER#")])

    def test_transaction_rechecks_workspace_and_membership(self):
        self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})
        items = self.client.calls[0]
        self.assertEqual(len(items), 6)
        checks = [i["ConditionCheck"] for i in items if "ConditionCheck" in i]
        self.assertEqual(_deserialize(checks[0]["Key"]), {"pk": f"WORKSPACE#{WS_A}", "sk": "METADATA"})
        self.assertEqual(checks[0]["ConditionExpression"], "attribute_exists(pk)")
        self.assertEqual(_deserialize(checks[1]["Key"]), {"pk": f"USER#{USER}", "sk": f"WORKSPACE#{WS_A}"})

    def test_member_can_create(self):
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "low", "workspaceId": WS_A}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 201)
        self.assertEqual(response_body(resp)["cve"]["createdBy"], MEMBER)

    def test_non_member_gets_404_and_nothing_is_written(self):
        before = copy.deepcopy(self.table.items)
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp)["error"], "Workspace not found")
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.table.items, before)

    def test_unknown_workspace_and_bad_id(self):
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_B})
        self.assertEqual(resp["statusCode"], 404)
        for bad in ["", "not-a-uuid", WS_A.upper(), f"{WS_A}\n", None, 7]:
            with self.subTest(workspaceId=bad):
                resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": bad})
                self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_membership_without_workspace_record_is_404(self):
        self.table.items.pop((f"WORKSPACE#{WS_A}", "METADATA"))
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.client.calls, [])

    def test_membership_removed_during_request_writes_nothing(self):
        before = copy.deepcopy(self.table.items)
        self.client.before_transact = lambda t: t.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"))
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 404)
        before.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"))
        self.assertEqual(self.table.items, before)

    def test_legacy_role_is_not_a_membership(self):
        self.table.items[(f"USER#{OTHER_USER}", f"WORKSPACE#{WS_A}")] = {
            "pk": f"USER#{OTHER_USER}", "sk": f"WORKSPACE#{WS_A}", "role": "viewer"}
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=OTHER_USER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.client.calls, [])


class TransactionFailureTests(ApiTestCase):
    def test_conflict_is_409_and_other_failures_500(self):
        self.client.fail_code = "TransactionConflict"
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high"})
        self.assertEqual(resp["statusCode"], 409)
        self.client.fail_code = "ThrottlingError"
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high"})
        self.assertEqual(resp["statusCode"], 500)
        self.assertEqual(self.table.items, {})


# --- Uniqueness ------------------------------------------------------------------------------

class UniquenessTests(ApiTestCase):
    rows = workspace_rows(WS_A, {USER: "owner", MEMBER: "member"}) + workspace_rows(WS_B, {USER: "owner"})

    def test_duplicate_personal_cve_is_409_with_existing_record(self):
        first = response_body(self.create({"cveId": "CVE-2021-37584", "severity": "high"}))["cve"]
        before = copy.deepcopy(self.table.items)
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "low"})
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(response_body(resp), {
            "error": "CVE-2021-37584 is already recorded in this scope",
            "cveId": "CVE-2021-37584", "cveRecordId": first["cveRecordId"]})
        self.assertEqual(self.table.items, before)

    def test_duplicate_workspace_cve_is_409_whoever_creates_it(self):
        first = response_body(self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}))
        before = copy.deepcopy(self.table.items)
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(response_body(resp)["cveRecordId"], first["cve"]["cveRecordId"])
        self.assertEqual(self.table.items, before)

    def test_case_and_unicode_variants_are_duplicates(self):
        self.create({"cveId": "CVE-2021-37584", "severity": "high"})
        self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})
        for variant in ["cve-2021-37584", " CVE-2021-37584 ", "CVE–2021–37584", "Cve−2021‑37584"]:
            with self.subTest(variant=variant):
                self.assertEqual(self.create({"cveId": variant, "severity": "high"})["statusCode"], 409)
                resp = self.create({"cveId": variant, "severity": "high", "workspaceId": WS_A}, user=MEMBER)
                self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(len([k for k in self.table.items if k[1] == "METADATA" and k[0].startswith("CVE#")]), 2)

    def test_same_cve_in_different_scopes(self):
        statuses = [
            self.create({"cveId": "CVE-2021-37584", "severity": "high"})["statusCode"],
            self.create({"cveId": "CVE-2021-37584", "severity": "high"}, user=MEMBER)["statusCode"],
            self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})["statusCode"],
            self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_B})["statusCode"],
        ]
        self.assertEqual(statuses, [201, 201, 201, 201])
        records = {i["cveRecordId"] for k, i in self.table.items.items() if k[1] == "METADATA" and k[0].startswith("CVE#")}
        self.assertEqual(len(records), 4)

    def test_claim_check_failing_alongside_membership_is_404(self):
        # A non-member must never learn whether the workspace has the CVE.
        self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=MEMBER)
        self.client.before_transact = lambda t: t.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"))
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertNotIn("cveRecordId", response_body(resp))


# --- Field validation -------------------------------------------------------------------------

class ValidationTests(ApiTestCase):
    def assertCreateStatus(self, extra, status, base=None):
        body = {"cveId": "CVE-2021-37584", "severity": "high", **(base or {}), **extra}
        resp = self.create(body)
        self.assertEqual(resp["statusCode"], status, response_body(resp))
        if status == 201:
            # Free the claim so the next case can create again.
            self.table.items.clear()
        return resp

    def test_severity_enum(self):
        for value in SEVERITY_OK:
            with self.subTest(severity=value):
                self.assertCreateStatus({"severity": value}, 201)
        for value in ["High", "HIGH", "none", "", None, 3, ["high"]]:
            with self.subTest(severity=value):
                self.assertCreateStatus({"severity": value}, 400)
        self.assertEqual(self.create({"cveId": "CVE-2021-37584"})["statusCode"], 400)

    def create_with_score(self, literal):
        # The JSON text is built by hand so the exact digits sent are known.
        return self.create('{"cveId": "CVE-2021-37584", "severity": "high", "cvssScore": %s}' % literal)

    def test_cvss_score_boundaries_and_any_precision(self):
        for literal in ["0", "0.0", "10", "10.0", "10.00", "7.5", "8.2", "8.25", "8.123", "9.99999", "0.001",
                        "5E0", "1e-30", "8.12345678901234567890123456789012345"]:
            with self.subTest(cvssScore=literal):
                resp = self.create_with_score(literal)
                self.assertEqual(resp["statusCode"], 201, response_body(resp))
                rid = response_body(resp)["cve"]["cveRecordId"]
                # Stored exactly as sent: a Decimal, never rounded through a float.
                stored = self.table.items[(f"CVE#{rid}", "METADATA")]["cvssScore"]
                self.assertIsInstance(stored, Decimal)
                self.assertEqual(stored, Decimal(literal))
                self.assertEqual(str(stored), str(Decimal(literal)))
                self.assertEqual(response_body(resp)["cve"]["cvssScore"], float(literal))
                self.table.items.clear()
        for literal in ["-0.1", "-1", "-0.0001", "10.1", "10.0001", "11", "100", "1e400", '"8.2"', "[8.2]",
                        '{"score": 8}']:
            with self.subTest(cvssScore=literal):
                self.assertEqual(self.create_with_score(literal)["statusCode"], 400)
        self.assertEqual(self.table.items, {})

    def test_negative_zero_is_zero(self):
        resp = self.create_with_score("-0.0")
        self.assertEqual(resp["statusCode"], 201)
        self.assertEqual(json.loads(resp["body"])["cve"]["cvssScore"], 0.0)
        self.assertEqual(str(response_body(resp)["cve"]["cvssScore"]), "0.0")

    def test_score_dynamodb_cannot_store_exactly_is_400(self):
        # In range, but beyond DynamoDB's 38 significant digits or its
        # smallest magnitude: refused, never rounded or failed with a 500.
        for literal in ["8.1234567890123456789012345678901234567890", "1e-200"]:
            with self.subTest(cvssScore=literal):
                resp = self.create_with_score(literal)
                self.assertEqual(resp["statusCode"], 400)
                self.assertEqual(response_body(resp)["error"], "cvssScore has more precision than can be stored")
        self.assertEqual(self.client.calls, [])

    def test_bool_rejected_as_score(self):
        for value in [True, False]:
            with self.subTest(cvssScore=value):
                self.assertCreateStatus({"cvssScore": value}, 400)

    def test_infinity_and_nan_literals_rejected(self):
        for literal in ["Infinity", "-Infinity", "NaN"]:
            with self.subTest(literal=literal):
                body = '{"cveId": "CVE-2021-37584", "severity": "high", "cvssScore": %s}' % literal
                self.assertEqual(self.create(body)["statusCode"], 400)

    def test_cvss_version_enum(self):
        for value in ["2.0", "3.0", "3.1", "4.0"]:
            with self.subTest(cvssVersion=value):
                self.assertCreateStatus({"cvssVersion": value}, 201)
        for value in [3.1, 3, "3", "v3.1", "3.1 ", "5.0", ""]:
            with self.subTest(cvssVersion=value):
                self.assertCreateStatus({"cvssVersion": value}, 400)

    def test_description_length(self):
        self.assertCreateStatus({"description": "x" * 4000}, 201)
        self.assertCreateStatus({"description": "  " + "x" * 4000 + "\n"}, 201)
        self.assertCreateStatus({"description": "line one\nline two\ttabbed\r\n"}, 201)
        for value in ["x" * 4001, 5, ["x"], "bell\x07", "nul\x00"]:
            with self.subTest(description=repr(value)[:20]):
                self.assertCreateStatus({"description": value}, 400)

    def test_chipset_limits(self):
        self.assertCreateStatus({"affectedChipsets": [f"CHIP{i}" for i in range(20)]}, 201)
        self.assertCreateStatus({"affectedChipsets": ["x" * 64]}, 201)
        for value in [[f"CHIP{i}" for i in range(21)], ["x" * 65], [""], ["  "], [None], [7], "MT7610UN",
                      ["MT76\n10"], {"chip": "MT7610UN"}]:
            with self.subTest(affectedChipsets=repr(value)[:30]):
                self.assertCreateStatus({"affectedChipsets": value}, 400)

    def test_chipsets_trimmed_and_deduplicated_case_insensitively(self):
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high",
                            "affectedChipsets": [" MT7610UN ", "mt7610un", "MT7612UN", "Mt7612un", "RTL8812AU"]})
        self.assertEqual(response_body(resp)["cve"]["affectedChipsets"], ["MT7610UN", "MT7612UN", "RTL8812AU"])

    def test_reference_count(self):
        self.assertCreateStatus({"references": [f"https://example.com/{i}" for i in range(20)]}, 201)
        self.assertCreateStatus({"references": [f"https://example.com/{i}" for i in range(21)]}, 400)

    def test_only_http_and_https_references(self):
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high",
                            "references": [" https://nvd.nist.gov/a ", "HTTP://example.com/b", "https://nvd.nist.gov/a"]})
        self.assertEqual(response_body(resp)["cve"]["references"], ["https://nvd.nist.gov/a", "HTTP://example.com/b"])
        self.table.items.clear()
        for value in ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "ftp://example.com",
                      "file:///etc/passwd", "//example.com", "example.com", "https://", "https:///path",
                      "https://exa mple.com", "https://example.com/\x00", "", "https://" + "a" * 2050, 7, None]:
            with self.subTest(reference=repr(value)[:30]):
                self.assertCreateStatus({"references": [value]}, 400)
        self.assertCreateStatus({"references": "https://example.com"}, 400)

    def test_unsupported_fields_rejected(self):
        for field in ["name", "severityScore", "notes", "workspace", "owner"]:
            with self.subTest(field=field):
                resp = self.assertCreateStatus({field: "x"}, 400)
                self.assertIn("Unsupported field", response_body(resp)["error"])
        self.assertEqual(self.client.calls, [])


SEVERITY_OK = ["low", "medium", "high", "critical"]


# --- GET /cves ----------------------------------------------------------------------------------

class ListCvesTests(ApiTestCase):
    rows = (
        workspace_rows(WS_A, {USER: "owner", MEMBER: "member"})
        + workspace_rows(WS_B, {OTHER_USER: "owner"})
        + personal_cve_rows(CVE_P, "CVE-2020-26652", description="long text",
                            references=["https://example.com"], cvssScore=Decimal("7.5"))
        + workspace_cve_rows(CVE_A, "CVE-2021-37584", WS_A, description="long text",
                             affectedChipsets=["MT7610UN", "MT7612UN"])
        + workspace_cve_rows(CVE_B, "CVE-2022-26445", WS_B)
    )

    def test_personal_list(self):
        resp = self.list()
        self.assertEqual(resp["statusCode"], 200)
        body = response_body(resp)
        self.assertEqual(body, {"cves": [{
            "cveRecordId": CVE_P, "cveId": "CVE-2020-26652", "severity": "high", "cvssScore": 7.5,
            "cvssVersion": None, "affectedChipsets": [], "createdBy": USER,
            "createdAt": "2026-10-02T00:00:00.000000+00:00", "updatedAt": "2026-10-02T00:00:00.000000+00:00",
            "version": 1,
        }]})
        self.assertIn((f"USER#{USER}", "CVE#"), self.table.queries)

    def test_list_omits_long_fields_and_projects_them_out(self):
        for cve in response_body(self.list())["cves"] + response_body(self.list(workspace_id=WS_A))["cves"]:
            self.assertNotIn("description", cve)
            self.assertNotIn("references", cve)
        for request in self.resource.batch_requests:
            projected = set(request["ExpressionAttributeNames"].values())
            self.assertNotIn("description", projected)
            self.assertNotIn("references", projected)
            self.assertIn("affectedChipsets", projected)

    def test_workspace_list(self):
        for user in (USER, MEMBER):
            with self.subTest(user=user):
                resp = self.list(user=user, workspace_id=WS_A)
                self.assertEqual(resp["statusCode"], 200)
                body = response_body(resp)
                self.assertEqual(body["workspaceId"], WS_A)
                self.assertEqual([c["cveRecordId"] for c in body["cves"]], [CVE_A])
                self.assertEqual(body["cves"][0]["workspaceId"], WS_A)
                self.assertEqual(body["cves"][0]["affectedChipsets"], ["MT7610UN", "MT7612UN"])

    def test_workspace_list_requires_membership(self):
        for user in (OTHER_USER, "nobody"):
            with self.subTest(user=user):
                resp = self.list(user=user, workspace_id=WS_A)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": "Workspace not found"})
        self.assertEqual(self.list(workspace_id=MISSING)["statusCode"], 404)
        self.assertEqual(self.list(workspace_id="not-a-uuid")["statusCode"], 400)
        self.assertEqual(self.list(workspace_id="")["statusCode"], 400)

    def test_personal_list_leaves_out_workspace_cves(self):
        # A leftover USER#/CVE# owner row pointing at a workspace CVE.
        self.table.items[(f"USER#{USER}", f"CVE#{CVE_A}")] = {
            "pk": f"USER#{USER}", "sk": f"CVE#{CVE_A}", "entity": "user-cve", "role": "owner"}
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list())["cves"]], [CVE_P])

    def test_stale_workspace_rows_cannot_expose_another_scope(self):
        for rid in (CVE_B, CVE_P, MISSING):
            self.table.items[(f"WORKSPACE#{WS_A}", f"CVE#{rid}")] = {
                "pk": f"WORKSPACE#{WS_A}", "sk": f"CVE#{rid}", "entity": "workspace-cve"}
        cves = response_body(self.list(workspace_id=WS_A))["cves"]
        self.assertEqual([c["cveRecordId"] for c in cves], [CVE_A])

    def test_claim_rows_are_not_cve_links(self):
        # The fixtures already hold CVEID# claims in both scopes; a claim whose
        # record id isn't listed elsewhere must not surface either.
        self.table.items[(f"USER#{USER}", "CVEID#CVE-2023-0001")] = {
            "pk": f"USER#{USER}", "sk": "CVEID#CVE-2023-0001", "entity": "cve-claim", "cveRecordId": CVE_B}
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list())["cves"]], [CVE_P])
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list(workspace_id=WS_A))["cves"]], [CVE_A])
        requested = {k["pk"] for r in self.resource.batch_requests for k in r["Keys"]}
        self.assertFalse(any(pk.startswith("CVE#CVE-") or "CVEID" in pk for pk in requested))

    def test_malformed_or_wrong_entity_link_rows_are_ignored(self):
        # Another user's personal CVE: only a user-cve row with role owner
        # would make it the caller's.
        other = "0192c000-0000-7000-8000-0000000000aa"
        self.table.items.update({(r["pk"], r["sk"]): r for r in personal_cve_rows(other, "CVE-2023-1111",
                                                                                   owner=OTHER_USER)})
        self.table.items[(f"USER#{USER}", "CVE#not-a-uuid")] = {
            "pk": f"USER#{USER}", "sk": "CVE#not-a-uuid", "entity": "user-cve", "role": "owner"}
        self.table.items[(f"USER#{USER}", f"CVE#{other}")] = {
            "pk": f"USER#{USER}", "sk": f"CVE#{other}", "entity": "something-else", "role": "owner"}
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list())["cves"]], [CVE_P])
        self.table.items[(f"USER#{USER}", f"CVE#{other}")] = {
            "pk": f"USER#{USER}", "sk": f"CVE#{other}", "entity": "user-cve", "role": "viewer"}
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list())["cves"]], [CVE_P])

    def test_newest_first(self):
        newer = "0192d000-0000-7000-8000-000000000001"
        self.table.items.update({(r["pk"], r["sk"]): r for r in personal_cve_rows(newer, "CVE-2024-0001")})
        self.assertEqual([c["cveRecordId"] for c in response_body(self.list())["cves"]], [newer, CVE_P])

    def test_empty_lists(self):
        self.assertEqual(response_body(self.list(user=MEMBER)), {"cves": []})


# --- GET /cves/{cveRecordId} -----------------------------------------------------------------------

class GetCveTests(ApiTestCase):
    rows = (
        workspace_rows(WS_A, {USER: "owner", MEMBER: "member"})
        + personal_cve_rows(CVE_P, "CVE-2020-26652", description="DoS in rtl80211_send_chandef",
                            references=["https://example.com/a"], cvssScore=Decimal("7.5"), cvssVersion="3.1")
        + workspace_cve_rows(CVE_A, "CVE-2021-37584", WS_A)
    )

    def test_personal_owner_gets_full_record(self):
        resp = self.get(CVE_P)
        self.assertEqual(resp["statusCode"], 200)
        cve = response_body(resp)["cve"]
        self.assertEqual(cve["description"], "DoS in rtl80211_send_chandef")
        self.assertEqual(cve["references"], ["https://example.com/a"])
        self.assertEqual((cve["cvssScore"], cve["cvssVersion"]), (7.5, "3.1"))
        self.assertNotIn("workspaceId", cve)

    def test_workspace_members_get_it(self):
        for user in (USER, MEMBER):
            with self.subTest(user=user):
                resp = self.get(CVE_A, user=user)
                self.assertEqual(resp["statusCode"], 200)
                self.assertEqual(response_body(resp)["cve"]["workspaceId"], WS_A)

    def test_others_get_the_same_404_as_a_missing_record(self):
        missing = self.get(MISSING)
        self.assertEqual(missing["statusCode"], 404)
        for user, rid in [(OTHER_USER, CVE_P), (MEMBER, CVE_P), (OTHER_USER, CVE_A)]:
            with self.subTest(user=user, rid=rid):
                resp = self.get(rid, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(resp["body"], missing["body"])

    def test_personal_cve_needs_an_owner_link(self):
        # Personal CVEs follow the device rule: only a USER#/CVE# row with
        # role owner authorizes, for reads as well as writes.
        self.table.items[(f"USER#{OTHER_USER}", f"CVE#{CVE_P}")] = {
            "pk": f"USER#{OTHER_USER}", "sk": f"CVE#{CVE_P}", "entity": "user-cve", "role": "viewer"}
        self.assertEqual(self.get(CVE_P, user=OTHER_USER)["statusCode"], 404)
        self.assertEqual(self.patch(CVE_P, {"severity": "low"}, user=OTHER_USER)["statusCode"], 404)
        self.assertEqual(self.table.items[(f"CVE#{CVE_P}", "METADATA")]["severity"], "high")

    def test_bad_ids(self):
        for rid in ["not-a-uuid", CVE_P.upper(), f"{CVE_P}\n", "CVE-2021-37584", ""]:
            with self.subTest(rid=rid):
                self.assertEqual(self.get(rid)["statusCode"], 400)

    def test_stale_owner_row_does_not_bypass_workspace_membership(self):
        # OTHER_USER once had (or forged) an ownership link to the workspace CVE.
        for row in [
            {"pk": f"USER#{OTHER_USER}", "sk": f"CVE#{CVE_A}", "entity": "user-cve", "role": "owner"},
            {"pk": f"CVE#{CVE_A}", "sk": f"USER#{OTHER_USER}", "entity": "cve-user", "role": "owner"},
        ]:
            self.table.items[(row["pk"], row["sk"])] = row
        self.assertEqual(self.get(CVE_A, user=OTHER_USER)["statusCode"], 404)
        self.assertEqual(self.patch(CVE_A, {"severity": "low"}, user=OTHER_USER)["statusCode"], 404)
        self.assertEqual(self.table.items[(f"CVE#{CVE_A}", "METADATA")]["severity"], "high")
        self.assertEqual(response_body(self.list(user=OTHER_USER)), {"cves": []})

    def test_unknown_route(self):
        resp = self.call("DELETE", "/cves/{cveRecordId}", path={"cveRecordId": CVE_P})
        self.assertEqual(resp["statusCode"], 404)
        self.assertIn((f"CVE#{CVE_P}", "METADATA"), self.table.items)
        self.assertEqual(self.call("PUT", "/cves")["statusCode"], 404)

    def test_missing_claims_is_401(self):
        resp = self.module.handler({"httpMethod": "GET", "resource": "/cves", "requestContext": {}}, None)
        self.assertEqual(resp["statusCode"], 401)


# --- PATCH /cves/{cveRecordId} -------------------------------------------------------------------

class PatchCveTests(ApiTestCase):
    rows = (
        workspace_rows(WS_A, {USER: "owner", MEMBER: "member"})
        + workspace_rows(WS_B, {USER: "owner"})
        + personal_cve_rows(CVE_P, "CVE-2020-26652", cvssScore=Decimal("7.5"), cvssVersion="3.1",
                            description="old", references=["https://example.com/a"],
                            affectedChipsets=["RTL8812AU"])
        + workspace_cve_rows(CVE_A, "CVE-2021-37584", WS_A)
    )

    def setUp(self):
        super().setUp()
        self.utcnow.return_value = LATER

    def meta(self, rid):
        return self.table.items[(f"CVE#{rid}", "METADATA")]

    def test_updates_allowed_fields(self):
        resp = self.patch(CVE_P, {"severity": "critical", "cvssScore": 9.8, "cvssVersion": "4.0",
                                  "description": " new ", "affectedChipsets": ["MT7610UN", "mt7610un"],
                                  "references": ["https://example.com/b"]})
        self.assertEqual(resp["statusCode"], 200)
        cve = response_body(resp)["cve"]
        self.assertEqual((cve["severity"], cve["cvssScore"], cve["cvssVersion"], cve["description"],
                          cve["affectedChipsets"], cve["references"]),
                         ("critical", 9.8, "4.0", "new", ["MT7610UN"], ["https://example.com/b"]))
        meta = self.meta(CVE_P)
        self.assertEqual(meta["cvssScore"], Decimal("9.8"))
        self.assertEqual(meta["affectedChipsets"], ["MT7610UN"])
        self.assertEqual(cve, self.module._public_cve(meta))

    def test_version_increments_and_updated_at_changes(self):
        before = copy.deepcopy(self.meta(CVE_P))
        cve = response_body(self.patch(CVE_P, {"severity": "low"}))["cve"]
        self.assertEqual(cve["version"], 2)
        self.assertEqual(cve["updatedAt"], LATER.isoformat(timespec="microseconds"))
        self.assertEqual(cve["createdAt"], before["createdAt"])
        self.assertEqual(self.meta(CVE_P)["version"], 2)
        self.assertNotEqual(self.meta(CVE_P)["updatedAt"], before["updatedAt"])
        self.assertEqual(response_body(self.patch(CVE_P, {"severity": "medium"}))["cve"]["version"], 3)

    def test_untouched_fields_are_kept(self):
        self.patch(CVE_P, {"severity": "low"})
        meta = self.meta(CVE_P)
        self.assertEqual((meta["cvssScore"], meta["description"], meta["cveId"], meta["createdBy"]),
                         (Decimal("7.5"), "old", "CVE-2020-26652", USER))

    def test_null_or_empty_clears_optional_fields(self):
        resp = self.patch(CVE_P, {"cvssScore": None, "cvssVersion": None, "description": "",
                                  "affectedChipsets": [], "references": None})
        self.assertEqual(resp["statusCode"], 200)
        meta = self.meta(CVE_P)
        for field in ("cvssScore", "cvssVersion", "description", "affectedChipsets", "references"):
            self.assertNotIn(field, meta)
        cve = response_body(resp)["cve"]
        self.assertEqual((cve["cvssScore"], cve["description"], cve["affectedChipsets"]), (None, None, []))

    def test_severity_cannot_be_cleared(self):
        for value in [None, "", "severe"]:
            with self.subTest(severity=value):
                self.assertEqual(self.patch(CVE_P, {"severity": value})["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_patch_accepts_any_precision_score(self):
        resp = self.patch(CVE_P, '{"cvssScore": 7.25}')
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.meta(CVE_P)["cvssScore"], Decimal("7.25"))
        self.assertEqual(response_body(resp)["cve"]["cvssScore"], 7.25)

    def test_patch_validates_like_post(self):
        for body in [{"cvssScore": True}, {"cvssScore": 10.5}, {"cvssVersion": "3"}, {"description": "x" * 4001},
                     {"affectedChipsets": ["x"] * 21}, {"references": ["javascript:alert(1)"]}]:
            with self.subTest(body=str(body)[:40]):
                self.assertEqual(self.patch(CVE_P, body)["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_immutable_fields_rejected(self):
        for field, value in [("cveId", "CVE-2021-0001"), ("cveRecordId", CVE_A), ("workspaceId", WS_A),
                             ("createdBy", OTHER_USER), ("createdAt", "2020-01-01"), ("updatedAt", "2020-01-01"),
                             ("version", 99), ("deviceIds", ["x"])]:
            with self.subTest(field=field):
                resp = self.patch(CVE_P, {"severity": "low", field: value})
                self.assertEqual(resp["statusCode"], 400)
                self.assertEqual(response_body(resp)["error"], f"Field(s) cannot be set or changed: {field}")
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.meta(CVE_P)["version"], 1)

    def test_unsupported_and_empty_bodies(self):
        self.assertEqual(self.patch(CVE_P, {"notes": "x"})["statusCode"], 400)
        self.assertEqual(self.patch(CVE_P, {})["statusCode"], 400)
        self.assertEqual(self.patch(CVE_P, "[]")["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_workspace_members_can_patch_and_scope_is_kept(self):
        resp = self.patch(CVE_A, {"severity": "low"}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.meta(CVE_A)["workspaceId"], WS_A)
        update = self.client.calls[0][0]["Update"]
        self.assertIn("#workspaceId = :workspaceId", update["ConditionExpression"])
        check = self.client.calls[0][1]["ConditionCheck"]
        self.assertEqual(_deserialize(check["Key"]), {"pk": f"USER#{MEMBER}", "sk": f"WORKSPACE#{WS_A}"})

    def test_personal_patch_requires_no_workspace_and_rechecks_ownership(self):
        self.patch(CVE_P, {"severity": "low"})
        update, check = self.client.calls[0]
        self.assertIn("attribute_not_exists(#workspaceId)", update["Update"]["ConditionExpression"])
        self.assertEqual(_deserialize(check["ConditionCheck"]["Key"]), {"pk": f"USER#{USER}", "sk": f"CVE#{CVE_P}"})

    def test_scope_cannot_change(self):
        # Even a body that names a workspace (or Personal) can't move the CVE.
        for body in [{"workspaceId": WS_B}, {"workspaceId": None}]:
            with self.subTest(body=body):
                self.assertEqual(self.patch(CVE_A, {"severity": "low", **body})["statusCode"], 400)
        self.assertEqual(self.meta(CVE_A)["workspaceId"], WS_A)
        self.assertEqual(self.client.calls, [])

    def test_scope_changed_underneath_is_refused(self):
        def move(table):
            table.items[(f"CVE#{CVE_A}", "METADATA")]["workspaceId"] = WS_B
        self.client.before_transact = move
        resp = self.patch(CVE_A, {"severity": "low"})
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.meta(CVE_A)["severity"], "high")

    def test_others_get_404(self):
        for user, rid in [(OTHER_USER, CVE_P), (MEMBER, CVE_P), (OTHER_USER, CVE_A), (USER, MISSING)]:
            with self.subTest(user=user, rid=rid):
                resp = self.patch(rid, {"severity": "low"}, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": "CVE not found"})
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.meta(CVE_P)["severity"], "high")
        self.assertNotIn((f"CVE#{MISSING}", "METADATA"), self.table.items)

    def test_disappearing_metadata_is_not_recreated(self):
        self.client.before_transact = lambda t: t.items.pop((f"CVE#{CVE_P}", "METADATA"))
        resp = self.patch(CVE_P, {"severity": "low"})
        self.assertEqual(resp["statusCode"], 404)
        self.assertNotIn((f"CVE#{CVE_P}", "METADATA"), self.table.items)
        self.assertIn("attribute_exists(pk)", self.client.calls[0][0]["Update"]["ConditionExpression"])

    def test_concurrent_change_is_409(self):
        def bump(table):
            table.items[(f"CVE#{CVE_P}", "METADATA")]["version"] = Decimal(2)
        self.client.before_transact = bump
        resp = self.patch(CVE_P, {"severity": "low"})
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.meta(CVE_P)["severity"], "high")

    def test_membership_removed_during_patch_is_404(self):
        self.client.before_transact = lambda t: t.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"))
        resp = self.patch(CVE_A, {"severity": "low"}, user=MEMBER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.meta(CVE_A)["severity"], "high")
        self.assertEqual(self.meta(CVE_A)["version"], 1)


if __name__ == "__main__":
    unittest.main()
