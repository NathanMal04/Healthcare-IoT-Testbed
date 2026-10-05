"""Unit tests for cves-api (POST /cves, GET /cves, GET, PATCH and DELETE
/cves/{cveRecordId}, PUT and DELETE /cves/{cveRecordId}/devices/{deviceId}),
with DynamoDB replaced by in-memory fakes that evaluate the condition and
update expressions and enforce DynamoDB's transaction rules.

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
CVE_M = "0192c000-0000-7000-8000-00000000000c"  # personal, owned by MEMBER
DEV_P1 = "11111111-1111-4111-8111-000000000001"  # personal devices of USER
DEV_P2 = "11111111-1111-4111-8111-000000000002"
DEV_O = "11111111-1111-4111-8111-000000000003"  # personal device of OTHER_USER
DEV_A1 = "11111111-1111-4111-8111-0000000000a1"  # devices of WS_A
DEV_A2 = "11111111-1111-4111-8111-0000000000a2"
DEV_B = "11111111-1111-4111-8111-0000000000b1"  # device of WS_B
DEV_GONE = "11111111-1111-4111-8111-0000000000ff"
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

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def query(self, KeyConditionExpression, ScanIndexForward=True, ExclusiveStartKey=None, ConsistentRead=False):
        expression = KeyConditionExpression.get_expression()
        if expression["operator"] == "AND":  # pk = :pk AND begins_with(sk, :prefix)
            pk_cond, sk_cond = expression["values"]
            pk = pk_cond.get_expression()["values"][1]
            prefix = sk_cond.get_expression()["values"][1]
        else:  # pk = :pk, the whole partition
            pk, prefix = expression["values"][1], ""
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


MISSING_VALUE = object()
_TOKEN = re.compile(r"\s*(<>|<=|>=|=|<|>|\(|\)|,|\+|[#:]?[A-Za-z_][A-Za-z0-9_]*)")


class Expression:
    """Evaluates the condition and update expressions cves-api sends, the way
    DynamoDB does."""

    def __init__(self, names, values):
        self.names, self.values = names, values

    # --- conditions ---
    def condition(self, text, item):
        self.tokens, self.pos, self.item = _tokenize(text), 0, item or {}
        result = self._or()
        assert self.pos == len(self.tokens), f"trailing tokens in {text!r}"
        return result

    def _peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _take(self, expected=None):
        token = self._peek()
        assert token is not None and (expected is None or token == expected), (token, expected)
        self.pos += 1
        return token

    def _or(self):
        value = self._and()
        while self._peek() == "OR":
            self._take()
            value = self._and() or value
        return value

    def _and(self):
        value = self._not()
        while self._peek() == "AND":
            self._take()
            value = self._not() and value
        return value

    def _not(self):
        if self._peek() == "NOT":
            self._take()
            return not self._not()
        return self._primary()

    def _primary(self):
        token = self._peek()
        if token == "(":
            self._take()
            value = self._or()
            self._take(")")
            return value
        if token in ("attribute_exists", "attribute_not_exists"):
            self._take()
            self._take("(")
            present = self.path() in self.item
            self._take(")")
            return present if token == "attribute_exists" else not present
        if token == "contains":
            self._take()
            self._take("(")
            current = self.item.get(self.path(), MISSING_VALUE)
            self._take(",")
            value = self.operand()
            self._take(")")
            return current is not MISSING_VALUE and value in current
        left = self.operand()
        op = self._take()
        if op == "IN":
            self._take("(")
            options = [self.operand()]
            while self._peek() == ",":
                self._take()
                options.append(self.operand())
            self._take(")")
            return left is not MISSING_VALUE and left in options
        right = self.operand()
        if left is MISSING_VALUE or right is MISSING_VALUE:
            return False
        return {"=": left == right, "<>": left != right, "<": left < right, ">": left > right,
                "<=": left <= right, ">=": left >= right}[op]

    def path(self, token=None):
        token = token or self._take()
        if token.startswith("#"):
            return self.names[token]
        assert not token.startswith(":"), token
        return token

    def value(self, token):
        assert token.startswith(":"), token
        return self.values[token]

    def operand(self):
        token = self._peek()
        if token == "size":
            self._take()
            self._take("(")
            current = self.item.get(self.path(), MISSING_VALUE)
            self._take(")")
            return MISSING_VALUE if current is MISSING_VALUE else Decimal(len(current))
        if token.startswith(":"):
            return self.value(self._take())
        return self.item.get(self.path(), MISSING_VALUE)

    # --- updates ---
    def update(self, text, item):
        item = copy.deepcopy(item)
        parts = re.split(r"\b(SET|REMOVE|ADD|DELETE)\b", text)
        assert parts[0].strip() == "", text
        for action, body in zip(parts[1::2], parts[2::2]):
            for clause in (c.strip() for c in body.split(",") if c.strip()):
                if action == "SET":
                    target, rhs = (s.strip() for s in clause.split("="))
                    if "+" in rhs:
                        left, right = (s.strip() for s in rhs.split("+"))
                        item[self.path(target)] = item[self.path(left)] + self.value(right)
                    else:
                        item[self.path(target)] = self.value(rhs)
                elif action == "REMOVE":
                    item.pop(self.path(clause), None)
                elif action == "ADD":
                    target, token = clause.split()
                    attr, value = self.path(target), self.value(token)
                    assert isinstance(value, set) and value, "ADD needs a non-empty set"
                    item[attr] = set(item.get(attr, set())) | value
                elif action == "DELETE":
                    target, token = clause.split()
                    attr, value = self.path(target), self.value(token)
                    remaining = set(item.get(attr, set())) - value
                    # DynamoDB would silently drop the attribute; cves-api must
                    # REMOVE it explicitly instead, so emptying a set is a bug.
                    assert remaining, "DELETE would leave an empty set; REMOVE the attribute instead"
                    item[attr] = remaining
        return item


def _tokenize(text):
    tokens, pos, text = [], 0, text.strip()
    while pos < len(text):
        match = _TOKEN.match(text, pos)
        assert match, f"cannot parse {text[pos:]!r}"
        tokens.append(match.group(1))
        pos = match.end()
    return tokens


def assert_all_used(spec):
    # DynamoDB rejects a request that defines a #name or :value its
    # expressions don't use.
    text = " ".join(spec.get(k, "") for k in ("ConditionExpression", "UpdateExpression"))
    used = set(re.findall(r"[#:][A-Za-z_][A-Za-z0-9_]*", text))
    defined = set(spec.get("ExpressionAttributeNames") or {}) | set(spec.get("ExpressionAttributeValues") or {})
    assert defined == used, f"defined but unused {defined - used}, used but undefined {used - defined}"


def assert_no_empty_sets(item):
    for name, value in (item or {}).items():
        assert not (isinstance(value, set) and not value), f"empty set written to {name}"


class FakeClient:
    """transact_write_items applied all-or-nothing to the FakeTable, with the
    per-item CancellationReasons DynamoDB returns, and DynamoDB's validation
    (at most 100 items, one operation per item, no unused names or values).
    before_transact runs first, to change the table between the Lambda's
    reads and its write."""

    def __init__(self, table, fail_code=None):
        self.table = table
        self.fail_code = fail_code
        self.calls = []
        self.before_transact = None

    def transact_write_items(self, TransactItems):
        self.calls.append(TransactItems)
        assert 0 < len(TransactItems) <= 100, f"{len(TransactItems)} items in one transaction"
        if self.before_transact:
            self.before_transact(self.table)
        writes, reasons, keys = [], [], set()
        for t in TransactItems:
            (op, spec), = t.items()
            assert op in ("Put", "Update", "Delete", "ConditionCheck"), op
            assert spec["TableName"] == TABLE
            if op == "Put":
                item = _deserialize(spec["Item"])
                assert_no_empty_sets(item)
                key = (item["pk"], item["sk"])
            else:
                k = _deserialize(spec["Key"])
                key, item = (k["pk"], k["sk"]), None
            assert key not in keys, f"two operations on {key} in one transaction"
            keys.add(key)
            values = _deserialize(spec.get("ExpressionAttributeValues"))
            for value in values.values():
                assert not (isinstance(value, set) and not value), "empty set in expression values"
            expr = Expression(spec.get("ExpressionAttributeNames") or {}, values)
            current = self.table.items.get(key)
            ok = True
            if "ConditionExpression" in spec:
                ok = expr.condition(spec["ConditionExpression"], current)
            else:
                assert op != "ConditionCheck"
            if op == "Update" and ok:
                item = expr.update(spec["UpdateExpression"], current or {"pk": key[0], "sk": key[1]})
                assert_no_empty_sets(item)
            assert_all_used(spec)
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
            if op in ("Put", "Update"):
                self.table.items[key] = item
            elif op == "Delete":
                self.table.items.pop(key, None)
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


def personal_device_rows(device_id, owner=USER, name="Infusion pump"):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "name": name, "type": "pump",
         "status": "active"},
        {"pk": f"USER#{owner}", "sk": f"DEVICE#{device_id}", "entity": "user-device", "role": "owner", "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"USER#{owner}", "entity": "device-user", "role": "owner"},
    ]


def workspace_device_rows(device_id, workspace_id, name="Glucose monitor"):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "deviceId": device_id, "name": name,
         "type": "monitor", "status": "active", "workspaceId": workspace_id, "createdBy": USER},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"DEVICE#{device_id}", "entity": "workspace-device", "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "device-workspace"},
    ]


def link_rows(record_id, device_id, cve_id="CVE-2020-26652"):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": f"CVE#{record_id}", "entity": "device-cve", "cveId": cve_id},
        {"pk": f"CVE#{record_id}", "sk": f"DEVICE#{device_id}", "entity": "cve-device", "deviceName": "x"},
    ]


def fake_device_id(i):
    return f"22222222-2222-4222-8222-{i:012d}"


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

    def link(self, record_id, device_id, user=USER):
        return self.call("PUT", "/cves/{cveRecordId}/devices/{deviceId}", user=user,
                         path={"cveRecordId": record_id, "deviceId": device_id})

    def unlink(self, record_id, device_id, user=USER):
        return self.call("DELETE", "/cves/{cveRecordId}/devices/{deviceId}", user=user,
                         path={"cveRecordId": record_id, "deviceId": device_id})

    def delete(self, record_id, user=USER):
        return self.call("DELETE", "/cves/{cveRecordId}", user=user, path={"cveRecordId": record_id})

    def meta(self, record_id):
        return self.table.items.get((f"CVE#{record_id}", "METADATA"))

    def rows_mentioning(self, record_id):
        """Every row whose pk or sk names the CVE record, in any partition."""
        return {k for k in self.table.items if f"CVE#{record_id}" in k}

    def assertDeviceIdsInvariant(self):
        # Zero devices: no attribute. One or more: a non-empty String Set.
        for (pk, sk), item in self.table.items.items():
            if pk.startswith("CVE#") and sk == "METADATA" and "deviceIds" in item:
                self.assertIsInstance(item["deviceIds"], set)
                self.assertTrue(item["deviceIds"], f"empty deviceIds on {pk}")

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
            "cvssVersion": "3.1", "affectedChipsets": ["MT7610UN", "MT7612UN"], "deviceIds": [], "createdBy": USER,
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
            "cvssVersion": None, "affectedChipsets": [], "deviceIds": [], "createdBy": USER,
            "createdAt": "2026-10-02T00:00:00.000000+00:00", "updatedAt": "2026-10-02T00:00:00.000000+00:00",
            "version": 1, "description": "long text",
        }]})
        self.assertIn((f"USER#{USER}", "CVE#"), self.table.queries)

    def test_list_includes_description_but_not_references(self):
        # The web app searches descriptions client-side; references stay detail-only.
        personal = response_body(self.list())["cves"]
        workspace = response_body(self.list(workspace_id=WS_A))["cves"]
        self.assertEqual([c["description"] for c in personal + workspace], ["long text", "long text"])
        for cve in personal + workspace:
            self.assertNotIn("references", cve)
        for request in self.resource.batch_requests:
            projected = set(request["ExpressionAttributeNames"].values())
            self.assertIn("description", projected)
            self.assertNotIn("references", projected)
            self.assertIn("affectedChipsets", projected)
            self.assertIn("deviceIds", projected)

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
        resp = self.call("PUT", "/cves/{cveRecordId}", path={"cveRecordId": CVE_P})
        self.assertEqual(resp["statusCode"], 404)
        resp = self.call("PATCH", "/cves/{cveRecordId}/devices/{deviceId}",
                         path={"cveRecordId": CVE_P, "deviceId": DEV_P1})
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.call("PUT", "/cves")["statusCode"], 404)
        self.assertEqual(self.call("GET", "/cves/{cveRecordId}/devices")["statusCode"], 404)
        self.assertIn((f"CVE#{CVE_P}", "METADATA"), self.table.items)
        self.assertEqual(self.client.calls, [])

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


# --- Stage 3B.2: device links ----------------------------------------------------------

ASSOCIATION_ROWS = (
    workspace_rows(WS_A, {USER: "owner", MEMBER: "member"})
    + workspace_rows(WS_B, {USER: "owner", OTHER_USER: "owner"})
    + personal_cve_rows(CVE_P, "CVE-2020-26652")
    + personal_cve_rows(CVE_M, "CVE-2020-26652", owner=MEMBER)
    + workspace_cve_rows(CVE_A, "CVE-2021-37584", WS_A)
    + workspace_cve_rows(CVE_B, "CVE-2022-26445", WS_B)
    + personal_device_rows(DEV_P1, name="Pump 1") + personal_device_rows(DEV_P2, name="Pump 2")
    + personal_device_rows(DEV_O, owner=OTHER_USER)
    + workspace_device_rows(DEV_A1, WS_A, name="Monitor A1") + workspace_device_rows(DEV_A2, WS_A)
    + workspace_device_rows(DEV_B, WS_B)
)


class LinkTests(ApiTestCase):
    rows = ASSOCIATION_ROWS

    def assertNothingWritten(self, before):
        self.assertEqual(self.table.items, before)

    def test_personal_link_writes_both_rows_and_the_set(self):
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        body = response_body(resp)
        self.assertTrue(body["changed"])
        self.assertEqual((body["cve"]["deviceIds"], body["cve"]["version"]), ([DEV_P1], 2))

        meta = self.meta(CVE_P)
        self.assertEqual(meta["deviceIds"], {DEV_P1})
        self.assertEqual(meta["version"], 2)
        self.assertEqual(meta["updatedAt"], NOW.isoformat(timespec="microseconds"))
        forward = self.table.items[(f"DEVICE#{DEV_P1}", f"CVE#{CVE_P}")]
        self.assertEqual((forward["entity"], forward["cveId"], forward["createdBy"]),
                         ("device-cve", "CVE-2020-26652", USER))
        reverse = self.table.items[(f"CVE#{CVE_P}", f"DEVICE#{DEV_P1}")]
        self.assertEqual((reverse["entity"], reverse["deviceName"]), ("cve-device", "Pump 1"))

        # METADATA update, 2 Puts, device scope check, CVE ownership, device ownership.
        items = self.client.calls[0]
        self.assertEqual(len(items), 6)
        checks = [_deserialize(i["ConditionCheck"]["Key"]) for i in items if "ConditionCheck" in i]
        self.assertEqual(checks, [
            {"pk": f"DEVICE#{DEV_P1}", "sk": "METADATA"},
            {"pk": f"USER#{USER}", "sk": f"CVE#{CVE_P}"},
            {"pk": f"USER#{USER}", "sk": f"DEVICE#{DEV_P1}"},
        ])
        self.assertIn("attribute_not_exists(#workspaceId)", items[3]["ConditionCheck"]["ConditionExpression"])

    def test_workspace_owner_and_member_link(self):
        self.assertEqual(self.link(CVE_A, DEV_A2, user=USER)["statusCode"], 200)
        resp = self.link(CVE_A, DEV_A1, user=MEMBER)
        self.assertEqual(resp["statusCode"], 200)
        cve = response_body(resp)["cve"]
        self.assertEqual(cve["deviceIds"], sorted([DEV_A1, DEV_A2]))
        self.assertEqual(cve["version"], 3)
        self.assertEqual(self.meta(CVE_A)["deviceIds"], {DEV_A1, DEV_A2})
        self.assertEqual(self.table.items[(f"DEVICE#{DEV_A1}", f"CVE#{CVE_A}")]["createdBy"], MEMBER)
        # METADATA update, 2 Puts, device workspace check, membership check.
        items = self.client.calls[1]
        self.assertEqual(len(items), 5)
        self.assertEqual(items[3]["ConditionCheck"]["ConditionExpression"], "#workspaceId = :workspaceId")
        self.assertEqual(_deserialize(items[4]["ConditionCheck"]["Key"]),
                         {"pk": f"USER#{MEMBER}", "sk": f"WORKSPACE#{WS_A}"})

    def test_scope_mismatches_are_400_and_write_nothing(self):
        before = copy.deepcopy(self.table.items)
        for rid, did in [(CVE_P, DEV_A1),   # personal CVE, workspace device
                         (CVE_A, DEV_P1),   # workspace CVE, personal device
                         (CVE_A, DEV_B),    # workspace A CVE, workspace B device (USER is in both)
                         (CVE_B, DEV_A1)]:
            with self.subTest(cve=rid, device=did):
                resp = self.link(rid, did)
                self.assertEqual(resp["statusCode"], 400)
                self.assertEqual(response_body(resp)["error"], "Device belongs to a different scope than the CVE")
        self.assertEqual(self.client.calls, [])
        self.assertNothingWritten(before)

    def test_device_the_caller_cannot_use_is_404_like_a_missing_one(self):
        missing = self.link(CVE_P, DEV_GONE)
        self.assertEqual(missing["statusCode"], 404)
        self.assertEqual(response_body(missing), {"error": "Device not found"})
        for user, rid, did in [(USER, CVE_P, DEV_O),        # another user's personal device
                               (MEMBER, CVE_A, DEV_B),      # a workspace MEMBER isn't in
                               (MEMBER, CVE_M, DEV_P1)]:    # USER's personal device
            with self.subTest(user=user, device=did):
                resp = self.link(rid, did, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(resp["body"], missing["body"])
        self.assertEqual(self.client.calls, [])

    def test_non_owner_device_link_does_not_authorize(self):
        # Personal devices follow the device endpoints: only role owner counts.
        self.table.items[(f"USER#{USER}", f"DEVICE#{DEV_O}")] = {
            "pk": f"USER#{USER}", "sk": f"DEVICE#{DEV_O}", "entity": "user-device", "role": "viewer"}
        resp = self.link(CVE_P, DEV_O)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Device not found"})
        self.assertEqual(self.client.calls, [])

    def test_cve_the_caller_cannot_use_is_404(self):
        for user, rid, did in [(OTHER_USER, CVE_P, DEV_O), (OTHER_USER, CVE_A, DEV_B), (USER, MISSING, DEV_P1)]:
            with self.subTest(user=user, cve=rid):
                resp = self.link(rid, did, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": "CVE not found"})
        self.assertEqual(self.client.calls, [])

    def test_stale_owner_row_on_a_workspace_device_never_links_it(self):
        # MEMBER is not in WS_B but holds a leftover USER#/DEVICE# owner row
        # for its device: neither MEMBER's personal CVE nor CVE_A may link it.
        for row in [{"pk": f"USER#{MEMBER}", "sk": f"DEVICE#{DEV_B}", "entity": "user-device", "role": "owner"},
                    {"pk": f"DEVICE#{DEV_B}", "sk": f"USER#{MEMBER}", "entity": "device-user", "role": "owner"}]:
            self.table.items[(row["pk"], row["sk"])] = row
        before = copy.deepcopy(self.table.items)
        self.assertEqual(self.link(CVE_M, DEV_B, user=MEMBER)["statusCode"], 404)
        self.assertEqual(self.link(CVE_A, DEV_B, user=MEMBER)["statusCode"], 404)
        self.assertNothingWritten(before)

    def test_stale_owner_row_cannot_pass_the_in_transaction_scope_check(self):
        # The device becomes a workspace device between the reads and the
        # write, while the USER#/DEVICE# owner row stays: still refused.
        expected = copy.deepcopy(self.table.items)
        expected[(f"DEVICE#{DEV_P1}", "METADATA")]["workspaceId"] = WS_A
        self.client.before_transact = (
            lambda t: t.items[(f"DEVICE#{DEV_P1}", "METADATA")].update(workspaceId=WS_A))
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(response_body(resp), {"error": "Device not found"})
        self.assertNothingWritten(expected)

    def test_device_moving_workspace_or_disappearing_during_link(self):
        cases = {
            "moved": lambda t: t.items[(f"DEVICE#{DEV_A1}", "METADATA")].update(workspaceId=WS_B),
            "deleted": lambda t: t.items.pop((f"DEVICE#{DEV_A1}", "METADATA")),
        }
        for name, change in cases.items():
            with self.subTest(name):
                self.use_table(FakeTable(self.rows))
                self.client.before_transact = change
                resp = self.link(CVE_A, DEV_A1)
                self.assertEqual(resp["statusCode"], 404)
                self.assertNotIn((f"CVE#{CVE_A}", f"DEVICE#{DEV_A1}"), self.table.items)
                self.assertNotIn("deviceIds", self.meta(CVE_A))

    def test_authorization_removed_during_link(self):
        cases = [
            ("membership", MEMBER, CVE_A, DEV_A1, (f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"), "CVE not found"),
            ("cve ownership", USER, CVE_P, DEV_P1, (f"USER#{USER}", f"CVE#{CVE_P}"), "CVE not found"),
            ("device ownership", USER, CVE_P, DEV_P1, (f"USER#{USER}", f"DEVICE#{DEV_P1}"), "Device not found"),
        ]
        for name, user, rid, did, key, error in cases:
            with self.subTest(name):
                self.use_table(FakeTable(self.rows))
                self.client.before_transact = lambda t, key=key: t.items.pop(key)
                resp = self.link(rid, did, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": error})
                self.assertNotIn((f"CVE#{rid}", f"DEVICE#{did}"), self.table.items)
                self.assertNotIn((f"DEVICE#{did}", f"CVE#{rid}"), self.table.items)

    def test_cve_deleted_during_link_is_404_and_not_recreated(self):
        self.client.before_transact = lambda t: t.items.pop((f"CVE#{CVE_P}", "METADATA"))
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 404)
        self.assertIsNone(self.meta(CVE_P))
        self.assertNotIn((f"DEVICE#{DEV_P1}", f"CVE#{CVE_P}"), self.table.items)

    def test_link_is_idempotent(self):
        self.link(CVE_P, DEV_P1)
        before = copy.deepcopy(self.table.items)
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertFalse(response_body(resp)["changed"])
        self.assertEqual(response_body(resp)["cve"]["deviceIds"], [DEV_P1])
        self.assertEqual(len(self.client.calls), 1)  # the second link wrote nothing
        self.assertNothingWritten(before)

    def test_same_device_linked_concurrently_is_unchanged(self):
        def concurrent(table):
            for row in link_rows(CVE_P, DEV_P1):
                table.items[(row["pk"], row["sk"])] = row
            meta = table.items[(f"CVE#{CVE_P}", "METADATA")]
            meta["deviceIds"], meta["version"] = {DEV_P1}, Decimal(2)
        self.client.before_transact = concurrent
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertFalse(response_body(resp)["changed"])
        self.assertEqual(self.meta(CVE_P)["version"], 2)

    def test_concurrent_links_of_different_devices_both_succeed(self):
        # A link has no version condition: adding to the set commutes.
        def other_link(table):
            for row in link_rows(CVE_P, DEV_P2):
                table.items[(row["pk"], row["sk"])] = row
            meta = table.items[(f"CVE#{CVE_P}", "METADATA")]
            meta["deviceIds"], meta["version"] = {DEV_P2}, Decimal(2)
        self.client.before_transact = other_link
        resp = self.link(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P1, DEV_P2})
        self.assertEqual(self.meta(CVE_P)["version"], 3)
        self.assertEqual(response_body(resp)["cve"]["deviceIds"], sorted([DEV_P1, DEV_P2]))

    def test_transaction_conflict_is_409(self):
        self.client.fail_code = "TransactionConflict"
        self.assertEqual(self.link(CVE_P, DEV_P1)["statusCode"], 409)

    def test_bad_ids(self):
        for did in ["not-a-uuid", DEV_A1.upper(), f"{DEV_P1}\n", ""]:
            with self.subTest(deviceId=did):
                self.assertEqual(self.link(CVE_P, did)["statusCode"], 400)
                self.assertEqual(self.unlink(CVE_P, did)["statusCode"], 400)
        self.assertEqual(self.client.calls, [])

    def test_patch_after_link_still_works(self):
        self.link(CVE_P, DEV_P1)
        resp = self.patch(CVE_P, {"severity": "low"})
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["cve"]["version"], 3)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P1})


class DeviceLimitTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        rows = list(ASSOCIATION_ROWS)
        linked = {fake_device_id(i) for i in range(39)}
        for did in linked:
            rows += link_rows(CVE_P, did)
        rows += personal_device_rows(fake_device_id(100)) + personal_device_rows(fake_device_id(101))
        self.use_table(FakeTable(rows))
        self.table.items[(f"CVE#{CVE_P}", "METADATA")]["deviceIds"] = linked

    def test_fortieth_link_succeeds_and_forty_first_is_409(self):
        self.assertEqual(self.module.MAX_DEVICES_PER_CVE, 40)
        resp = self.link(CVE_P, fake_device_id(100))
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(len(self.meta(CVE_P)["deviceIds"]), 40)

        before = copy.deepcopy(self.table.items)
        resp = self.link(CVE_P, fake_device_id(101))
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(response_body(resp)["error"], "A CVE can be linked to at most 40 devices")
        self.assertEqual(self.table.items, before)

    def test_delete_at_the_limit_fits_one_transaction(self):
        self.link(CVE_P, fake_device_id(100))
        resp = self.delete(CVE_P)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["deleted"]["deviceCount"], 40)
        # METADATA, 2 scope rows, claim, 2 per device.
        self.assertEqual(len(self.client.calls[-1]), 4 + 2 * 40)
        self.assertEqual(self.rows_mentioning(CVE_P), set())

    def test_workspace_delete_at_the_limit_fits_one_transaction(self):
        rows = list(ASSOCIATION_ROWS)
        linked = {fake_device_id(i) for i in range(40)}
        for did in linked:
            rows += link_rows(CVE_A, did)
        self.use_table(FakeTable(rows))
        self.table.items[(f"CVE#{CVE_A}", "METADATA")]["deviceIds"] = linked
        resp = self.delete(CVE_A, user=MEMBER)
        self.assertEqual(resp["statusCode"], 200)
        # METADATA, 2 scope rows, claim, membership check, 2 per device: 85.
        self.assertEqual(len(self.client.calls[-1]), 5 + 2 * 40)
        self.assertLessEqual(len(self.client.calls[-1]), 100)
        self.assertEqual(self.rows_mentioning(CVE_A), set())

    def test_delete_over_the_limit_is_refused_without_writing(self):
        # Only reachable through corruption: refuse rather than delete part of it.
        for i in range(39, 45):
            for row in link_rows(CVE_P, fake_device_id(i)):
                self.table.items[(row["pk"], row["sk"])] = row
        before = copy.deepcopy(self.table.items)
        resp = self.delete(CVE_P)
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.table.items, before)


class UnlinkTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        rows = list(ASSOCIATION_ROWS)
        rows += link_rows(CVE_P, DEV_P1) + link_rows(CVE_P, DEV_P2) + link_rows(CVE_A, DEV_A1, "CVE-2021-37584")
        self.use_table(FakeTable(rows))
        self.table.items[(f"CVE#{CVE_P}", "METADATA")]["deviceIds"] = {DEV_P1, DEV_P2}
        self.table.items[(f"CVE#{CVE_A}", "METADATA")]["deviceIds"] = {DEV_A1}

    def test_two_to_one_leaves_a_one_element_string_set(self):
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        body = response_body(resp)
        self.assertTrue(body["changed"])
        self.assertEqual(body["cve"]["deviceIds"], [DEV_P2])
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P2})
        self.assertIsInstance(self.meta(CVE_P)["deviceIds"], set)
        self.assertEqual(self.meta(CVE_P)["version"], 2)
        self.assertNotIn((f"CVE#{CVE_P}", f"DEVICE#{DEV_P1}"), self.table.items)
        self.assertNotIn((f"DEVICE#{DEV_P1}", f"CVE#{CVE_P}"), self.table.items)
        self.assertIn((f"CVE#{CVE_P}", f"DEVICE#{DEV_P2}"), self.table.items)
        update = self.client.calls[0][0]["Update"]
        self.assertIn("DELETE #deviceIds :device", update["UpdateExpression"])
        self.assertNotIn("REMOVE", update["UpdateExpression"])
        self.assertIn("size(#deviceIds) > :one", update["ConditionExpression"])

    def test_one_to_zero_removes_the_attribute_explicitly(self):
        resp = self.unlink(CVE_A, DEV_A1, user=MEMBER)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["cve"]["deviceIds"], [])
        self.assertNotIn("deviceIds", self.meta(CVE_A))
        self.assertEqual(self.rows_mentioning(CVE_A) & {(f"DEVICE#{DEV_A1}", f"CVE#{CVE_A}"),
                                                         (f"CVE#{CVE_A}", f"DEVICE#{DEV_A1}")}, set())
        update = self.client.calls[0][0]["Update"]
        self.assertIn("REMOVE #deviceIds", update["UpdateExpression"])
        self.assertNotIn("DELETE", update["UpdateExpression"])
        self.assertIn("size(#deviceIds) = :one", update["ConditionExpression"])
        # Metadata update and both row deletes in one transaction, with the
        # membership re-check.
        ops = [next(iter(i)) for i in self.client.calls[0]]
        self.assertEqual(ops, ["Update", "Delete", "Delete", "ConditionCheck"])

    def test_both_unlinks_in_turn_end_with_no_attribute(self):
        self.unlink(CVE_P, DEV_P2)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P1})
        self.unlink(CVE_P, DEV_P1)
        self.assertNotIn("deviceIds", self.meta(CVE_P))
        self.assertEqual(self.meta(CVE_P)["version"], 3)
        self.assertDeviceIdsInvariant()

    def test_get_and_list_return_empty_list_when_absent(self):
        self.unlink(CVE_A, DEV_A1)
        self.assertEqual(response_body(self.get(CVE_A))["cve"]["deviceIds"], [])
        listed = response_body(self.list(workspace_id=WS_A))["cves"]
        self.assertEqual([c["deviceIds"] for c in listed], [[]])

    def test_already_unlinked_is_unchanged(self):
        self.unlink(CVE_P, DEV_P1)
        before = copy.deepcopy(self.table.items)
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertFalse(response_body(resp)["changed"])
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.table.items, before)
        # Never linked at all: the same, and the device is never read.
        resp = self.unlink(CVE_P, DEV_GONE)
        self.assertEqual((resp["statusCode"], response_body(resp)["changed"]), (200, False))

    def test_unlink_works_once_the_device_is_gone(self):
        self.table.items.pop((f"DEVICE#{DEV_P1}", "METADATA"))
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P2})

    def test_unlink_needs_access_to_the_cve(self):
        before = copy.deepcopy(self.table.items)
        for user, rid, did in [(OTHER_USER, CVE_A, DEV_A1), (MEMBER, CVE_P, DEV_P1), (OTHER_USER, CVE_P, DEV_P1)]:
            with self.subTest(user=user, cve=rid):
                resp = self.unlink(rid, did, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": "CVE not found"})
        self.assertEqual(self.table.items, before)

    def test_stale_owner_row_cannot_unlink_a_workspace_cve(self):
        self.table.items[(f"USER#{OTHER_USER}", f"CVE#{CVE_A}")] = {
            "pk": f"USER#{OTHER_USER}", "sk": f"CVE#{CVE_A}", "entity": "user-cve", "role": "owner"}
        self.assertEqual(self.unlink(CVE_A, DEV_A1, user=OTHER_USER)["statusCode"], 404)
        self.assertEqual(self.meta(CVE_A)["deviceIds"], {DEV_A1})

    def test_concurrent_unlink_of_the_same_device_is_unchanged(self):
        def concurrent(table):
            for row in link_rows(CVE_P, DEV_P1):
                table.items.pop((row["pk"], row["sk"]))
            meta = table.items[(f"CVE#{CVE_P}", "METADATA")]
            meta["deviceIds"], meta["version"] = {DEV_P2}, Decimal(2)
        self.client.before_transact = concurrent
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 200)
        self.assertFalse(response_body(resp)["changed"])
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P2})

    def test_concurrent_change_to_the_set_is_409(self):
        # Another device was linked between the read and the write: the
        # version check refuses, so the branch chosen (DELETE vs REMOVE) can
        # never act on a set it didn't see.
        def other_link(table):
            for row in link_rows(CVE_A, DEV_A2):
                table.items[(row["pk"], row["sk"])] = row
            meta = table.items[(f"CVE#{CVE_A}", "METADATA")]
            meta["deviceIds"], meta["version"] = {DEV_A1, DEV_A2}, Decimal(2)
        self.client.before_transact = other_link
        resp = self.unlink(CVE_A, DEV_A1)
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.meta(CVE_A)["deviceIds"], {DEV_A1, DEV_A2})
        self.assertIn((f"CVE#{CVE_A}", f"DEVICE#{DEV_A1}"), self.table.items)

    def test_any_change_to_the_cve_during_unlink_is_409(self):
        # The version check refuses even a change that leaves deviceIds alone
        # (a PATCH), so unlink only ever acts on exactly what it read.
        self.client.before_transact = lambda t: t.items[(f"CVE#{CVE_P}", "METADATA")].update(version=Decimal(2))
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P1, DEV_P2})
        self.assertIn((f"CVE#{CVE_P}", f"DEVICE#{DEV_P1}"), self.table.items)

    def test_membership_removed_during_unlink_is_404(self):
        self.client.before_transact = lambda t: t.items.pop((f"USER#{MEMBER}", f"WORKSPACE#{WS_A}"))
        resp = self.unlink(CVE_A, DEV_A1, user=MEMBER)
        self.assertEqual(resp["statusCode"], 404)
        self.assertEqual(self.meta(CVE_A)["deviceIds"], {DEV_A1})

    def test_rows_without_their_set_entry_are_still_removed(self):
        self.table.items[(f"CVE#{CVE_P}", "METADATA")]["deviceIds"] = {DEV_P2}
        resp = self.unlink(CVE_P, DEV_P1)
        self.assertEqual((resp["statusCode"], response_body(resp)["changed"]), (200, True))
        self.assertNotIn((f"CVE#{CVE_P}", f"DEVICE#{DEV_P1}"), self.table.items)
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P2})
        self.assertNotIn("deviceIds", self.client.calls[0][0]["Update"]["UpdateExpression"])

    def test_set_entry_without_its_rows_is_still_removed(self):
        for row in link_rows(CVE_P, DEV_P2):
            self.table.items.pop((row["pk"], row["sk"]))
        resp = self.unlink(CVE_P, DEV_P2)
        self.assertEqual((resp["statusCode"], response_body(resp)["changed"]), (200, True))
        self.assertEqual(self.meta(CVE_P)["deviceIds"], {DEV_P1})


class DeviceIdsInvariantTests(ApiTestCase):
    rows = ASSOCIATION_ROWS

    def test_no_empty_set_is_ever_stored(self):
        steps = [("link", DEV_P1), ("link", DEV_P2), ("unlink", DEV_P1), ("unlink", DEV_P2),
                 ("link", DEV_P2), ("unlink", DEV_P2), ("unlink", DEV_P2)]
        for action, did in steps:
            resp = (self.link if action == "link" else self.unlink)(CVE_P, did)
            self.assertEqual(resp["statusCode"], 200, (action, did))
            self.assertDeviceIdsInvariant()
        self.assertNotIn("deviceIds", self.meta(CVE_P))

    def test_the_fake_refuses_an_update_that_would_empty_a_set(self):
        # The guard the tests above rely on: an unlink that used DELETE for
        # the final device would fail here instead of passing silently.
        self.table.items[(f"CVE#{CVE_P}", "METADATA")]["deviceIds"] = {DEV_P1}
        update = self.module._update(CVE_P, "DELETE #d :d", "attribute_exists(pk)", {"#d": "deviceIds"},
                                     {":d": {DEV_P1}})
        with self.assertRaisesRegex(AssertionError, "empty set"):
            self.client.transact_write_items([update])

    def test_legacy_record_without_device_ids(self):
        # Stage 3B.1 records have no deviceIds: read as [], linkable, deletable.
        self.assertNotIn("deviceIds", self.meta(CVE_A))
        self.assertEqual(response_body(self.get(CVE_A))["cve"]["deviceIds"], [])
        self.assertEqual(response_body(self.list(workspace_id=WS_A))["cves"][0]["deviceIds"], [])
        self.assertEqual(self.link(CVE_A, DEV_A1)["statusCode"], 200)
        self.assertEqual(self.meta(CVE_A)["deviceIds"], {DEV_A1})

    def test_device_ids_sorted_in_get_and_list(self):
        self.link(CVE_A, DEV_A2)
        self.link(CVE_A, DEV_A1)
        self.assertEqual(response_body(self.get(CVE_A))["cve"]["deviceIds"], [DEV_A1, DEV_A2])
        self.assertEqual(response_body(self.list(workspace_id=WS_A))["cves"][0]["deviceIds"], [DEV_A1, DEV_A2])

    def test_post_and_patch_still_refuse_device_ids(self):
        resp = self.create({"cveId": "CVE-2023-0001", "severity": "low", "deviceIds": [DEV_P1]})
        self.assertEqual(resp["statusCode"], 400)
        resp = self.patch(CVE_P, {"deviceIds": [DEV_P1]})
        self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(response_body(resp)["error"], "Field(s) cannot be set or changed: deviceIds")


# --- Stage 3B.2: DELETE /cves/{cveRecordId} ---------------------------------------------

class DeleteCveTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        rows = list(ASSOCIATION_ROWS)
        rows += link_rows(CVE_A, DEV_A1, "CVE-2021-37584") + link_rows(CVE_A, DEV_A2, "CVE-2021-37584")
        self.use_table(FakeTable(rows))
        self.table.items[(f"CVE#{CVE_A}", "METADATA")]["deviceIds"] = {DEV_A1, DEV_A2}

    def test_personal_cve_without_devices(self):
        resp = self.delete(CVE_P)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp), {"deleted": {
            "cveRecordId": CVE_P, "cveId": "CVE-2020-26652", "deviceCount": 0}})
        self.assertEqual(self.rows_mentioning(CVE_P), set())
        self.assertNotIn((f"USER#{USER}", "CVEID#CVE-2020-26652"), self.table.items)
        # MEMBER's personal CVE with the same cveId is untouched.
        self.assertIn((f"USER#{MEMBER}", "CVEID#CVE-2020-26652"), self.table.items)
        self.assertIsNotNone(self.meta(CVE_M))
        items = self.client.calls[0]
        self.assertEqual(len(items), 4)
        owner_delete = next(i["Delete"] for i in items
                            if _deserialize(i["Delete"]["Key"]) == {"pk": f"USER#{USER}", "sk": f"CVE#{CVE_P}"})
        self.assertEqual(owner_delete["ConditionExpression"], "#role = :owner")

    def test_workspace_cve_with_devices_by_a_member(self):
        resp = self.delete(CVE_A, user=MEMBER)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["deleted"]["deviceCount"], 2)
        self.assertEqual(self.rows_mentioning(CVE_A), set())
        self.assertNotIn((f"WORKSPACE#{WS_A}", "CVEID#CVE-2021-37584"), self.table.items)
        # The devices themselves, and other CVEs, are untouched.
        for did in (DEV_A1, DEV_A2):
            self.assertIn((f"DEVICE#{did}", "METADATA"), self.table.items)
        self.assertIsNotNone(self.meta(CVE_B))
        self.assertEqual(len(self.client.calls[0]), 5 + 2 * 2)

    def test_workspace_owner_can_delete(self):
        self.assertEqual(self.delete(CVE_A, user=USER)["statusCode"], 200)

    def test_cve_id_can_be_recorded_again_after_delete(self):
        self.delete(CVE_A)
        resp = self.create({"cveId": "CVE-2021-37584", "severity": "high", "workspaceId": WS_A})
        self.assertEqual(resp["statusCode"], 201)

    def test_deleted_cve_is_gone_everywhere(self):
        self.delete(CVE_A)
        self.assertEqual(self.get(CVE_A)["statusCode"], 404)
        self.assertNotIn(CVE_A, [c["cveRecordId"] for c in response_body(self.list(workspace_id=WS_A))["cves"]])
        self.assertEqual(self.link(CVE_A, DEV_A1)["statusCode"], 404)
        self.assertEqual(self.delete(CVE_A)["statusCode"], 404)

    def test_others_get_404_and_nothing_is_deleted(self):
        before = copy.deepcopy(self.table.items)
        for user, rid in [(OTHER_USER, CVE_A), (OTHER_USER, CVE_P), (MEMBER, CVE_P), (USER, MISSING)]:
            with self.subTest(user=user, cve=rid):
                resp = self.delete(rid, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertEqual(response_body(resp), {"error": "CVE not found"})
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.table.items, before)

    def test_stale_owner_row_cannot_delete_a_workspace_cve(self):
        self.table.items[(f"USER#{OTHER_USER}", f"CVE#{CVE_A}")] = {
            "pk": f"USER#{OTHER_USER}", "sk": f"CVE#{CVE_A}", "entity": "user-cve", "role": "owner"}
        self.assertEqual(self.delete(CVE_A, user=OTHER_USER)["statusCode"], 404)
        self.assertIsNotNone(self.meta(CVE_A))

    def test_claim_of_another_record_is_never_deleted(self):
        claim_key = (f"WORKSPACE#{WS_A}", "CVEID#CVE-2021-37584")
        self.table.items[claim_key]["cveRecordId"] = CVE_B
        resp = self.delete(CVE_A)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.table.items[claim_key]["cveRecordId"], CVE_B)
        self.assertIsNone(self.meta(CVE_A))

    def test_claim_changing_to_another_record_during_delete_cancels_it(self):
        claim_key = (f"WORKSPACE#{WS_A}", "CVEID#CVE-2021-37584")
        self.client.before_transact = lambda t: t.items[claim_key].update(cveRecordId=CVE_B)
        resp = self.delete(CVE_A)
        self.assertEqual(resp["statusCode"], 409)
        self.assertIsNotNone(self.meta(CVE_A))
        self.assertEqual(self.table.items[claim_key]["cveRecordId"], CVE_B)
        claim_delete = next(i["Delete"] for i in self.client.calls[0]
                            if _deserialize(i["Delete"]["Key"]) == dict(zip(("pk", "sk"), claim_key)))
        self.assertEqual(claim_delete["ConditionExpression"], "#cveRecordId = :rid")

    def test_missing_claim_does_not_block_delete(self):
        self.table.items.pop((f"USER#{USER}", "CVEID#CVE-2020-26652"))
        self.assertEqual(self.delete(CVE_P)["statusCode"], 200)
        self.assertEqual(self.rows_mentioning(CVE_P), set())

    def test_link_added_during_delete_cancels_it(self):
        def concurrent_link(table):
            for row in link_rows(CVE_A, fake_device_id(7), "CVE-2021-37584"):
                table.items[(row["pk"], row["sk"])] = row
            meta = table.items[(f"CVE#{CVE_A}", "METADATA")]
            meta["deviceIds"] = meta["deviceIds"] | {fake_device_id(7)}
            meta["version"] = meta["version"] + 1
        self.client.before_transact = concurrent_link
        resp = self.delete(CVE_A)
        self.assertEqual(resp["statusCode"], 409)
        # Nothing deleted: no orphaned link rows.
        self.assertIsNotNone(self.meta(CVE_A))
        self.assertIn((f"DEVICE#{fake_device_id(7)}", f"CVE#{CVE_A}"), self.table.items)
        self.assertIn((f"DEVICE#{DEV_A1}", f"CVE#{CVE_A}"), self.table.items)

    def test_patch_during_delete_cancels_it(self):
        self.client.before_transact = lambda t: t.items[(f"CVE#{CVE_P}", "METADATA")].update(version=Decimal(2))
        self.assertEqual(self.delete(CVE_P)["statusCode"], 409)
        self.assertIsNotNone(self.meta(CVE_P))

    def test_authorization_removed_during_delete_is_404(self):
        cases = [(MEMBER, CVE_A, (f"USER#{MEMBER}", f"WORKSPACE#{WS_A}")),
                 (USER, CVE_P, (f"USER#{USER}", f"CVE#{CVE_P}"))]
        for user, rid, key in cases:
            with self.subTest(user=user):
                self.client.before_transact = lambda t, key=key: t.items[key].update(role="viewer")
                resp = self.delete(rid, user=user)
                self.assertEqual(resp["statusCode"], 404)
                self.assertIsNotNone(self.meta(rid))

    def test_stale_and_inconsistent_rows_are_all_removed(self):
        # A leftover USER# pair on a workspace CVE, a link row whose id isn't in
        # deviceIds, and an id in deviceIds without its rows.
        extra = [{"pk": f"CVE#{CVE_A}", "sk": f"USER#{OTHER_USER}", "entity": "cve-user", "role": "owner"},
                 {"pk": f"USER#{OTHER_USER}", "sk": f"CVE#{CVE_A}", "entity": "user-cve", "role": "owner"},
                 *link_rows(CVE_A, fake_device_id(8), "CVE-2021-37584")]
        for row in extra:
            self.table.items[(row["pk"], row["sk"])] = row
        self.table.items[(f"CVE#{CVE_A}", "METADATA")]["deviceIds"] |= {fake_device_id(9)}
        resp = self.delete(CVE_A)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(response_body(resp)["deleted"]["deviceCount"], 4)
        self.assertEqual(self.rows_mentioning(CVE_A), set())

    def test_scope_rows_are_removed_even_if_the_cve_side_is_missing(self):
        for rid, sk in [(CVE_P, f"USER#{USER}"), (CVE_A, f"WORKSPACE#{WS_A}")]:
            with self.subTest(cve=rid):
                self.table.items.pop((f"CVE#{rid}", sk))
                self.assertEqual(self.delete(rid)["statusCode"], 200)
                self.assertEqual(self.rows_mentioning(rid), set())

    def test_malformed_link_row_never_becomes_a_key(self):
        self.table.items[(f"CVE#{CVE_P}", "DEVICE#a#b")] = {"pk": f"CVE#{CVE_P}", "sk": "DEVICE#a#b"}
        self.assertEqual(self.delete(CVE_P)["statusCode"], 200)
        keys = [_deserialize(next(iter(i.values()))["Key"]) for i in self.client.calls[0]]
        self.assertNotIn({"pk": "DEVICE#a#b", "sk": f"CVE#{CVE_P}"}, keys)
        self.assertEqual(self.rows_mentioning(CVE_P), set())

    def test_transaction_conflict_is_409(self):
        self.client.fail_code = "TransactionConflict"
        self.assertEqual(self.delete(CVE_P)["statusCode"], 409)
        self.assertIsNotNone(self.meta(CVE_P))


if __name__ == "__main__":
    unittest.main()
