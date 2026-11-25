"""Unit tests for delete-device (GET /devices/{deviceId}/deletion, DELETE
/devices/{deviceId} and the scheduled sweep), the shared deletion rule
(testbed_authz.may_delete_device) and canDelete on GET /devices/{deviceId}.

DynamoDB is the in-memory fake of the cves-api tests, which evaluates the
condition and update expressions and enforces DynamoDB's transaction rules;
S3 is a small fake bucket.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("DATA_LAKE_BUCKET", "data-lake")

# The expression evaluator and strict transaction fake of the cves-api tests,
# imported as a module so its test cases aren't collected here again.
import test_cves_api as fakes  # noqa: E402

LAMBDAS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
import testbed_authz  # noqa: E402

BUCKET = os.environ["DATA_LAKE_BUCKET"]
OWNER = "user-owner"
MEMBER = "user-member"        # created DEV_A
MEMBER2 = "user-member-2"     # a member who didn't create it
VIEWER = "user-viewer"
OUTSIDER = "user-outsider"    # owner of WS_B only
PERSONAL = "user-personal"
WS_A = "0192b000-0000-7000-8000-00000000000a"
WS_B = "0192b000-0000-7000-8000-00000000000b"
DEV_A = "11111111-1111-4111-8111-0000000000a1"   # the device being deleted (WS_A)
DEV_A2 = "11111111-1111-4111-8111-0000000000a2"  # another WS_A device
DEV_B = "11111111-1111-4111-8111-0000000000b1"   # a WS_B device
DEV_P = "11111111-1111-4111-8111-000000000001"   # personal device of PERSONAL
IMG = "0192d000-0000-7000-8000-000000000001"     # image of DEV_A only
FW = "0192d000-0000-7000-8000-000000000002"      # firmware of DEV_A only, in a batch
SHARED = "0192d000-0000-7000-8000-000000000003"  # pcap linked to DEV_A and DEV_A2
RUNIN = "0192d000-0000-7000-8000-000000000004"   # migrated firmware of DEV_A, input of a run
BATCH = "0192e000-0000-7000-8000-000000000001"
RUN = "0192f000-0000-7000-8000-000000000001"
CVE_SHARED = "0192c000-0000-7000-8000-000000000001"  # linked to DEV_A and DEV_A2
CVE_ONLY = "0192c000-0000-7000-8000-000000000002"    # linked to DEV_A only
NAME = "ALFA AWUS036ACH"
NOW = datetime(2026, 11, 25, 12, 0, 0, tzinfo=timezone.utc)
DELETIONS = "ACTIVE#DEVICE_DELETIONS"


class Table(fakes.FakeTable):
    """The cves-api fake, plus the projection arguments delete-device sends
    (whole rows are returned, which is a superset)."""

    def query(self, KeyConditionExpression, ConsistentRead=False, **kwargs):
        assert ConsistentRead, "cleanup must read strongly consistently"
        return super().query(KeyConditionExpression, ConsistentRead=ConsistentRead)


class FakeS3:
    """A bucket: list_objects_v2 in pages of two, delete_objects that can be
    told to refuse keys."""

    def __init__(self, keys):
        self.objects = set(keys)
        self.refuse = set()
        self.deleted = []

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        # Like S3, the token resumes after the last key returned, whatever
        # was deleted meanwhile.
        assert Bucket == BUCKET
        keys = sorted(k for k in self.objects if k.startswith(Prefix) and k > (ContinuationToken or ""))
        page = keys[:2]
        response = {"Contents": [{"Key": k} for k in page], "IsTruncated": len(keys) > 2}
        if response["IsTruncated"]:
            response["NextContinuationToken"] = page[-1]
        return response

    def delete_objects(self, Bucket, Delete):
        assert Bucket == BUCKET
        errors = []
        for obj in Delete["Objects"]:
            if obj["Key"] in self.refuse:
                errors.append({"Key": obj["Key"], "Code": "AccessDenied"})
            else:
                self.objects.discard(obj["Key"])
                self.deleted.append(obj["Key"])
        return {"Errors": errors} if errors else {}


def membership(workspace_id, members):
    return fakes.workspace_rows(workspace_id, members)


def device_rows(device_id, workspace_id, created_by, name=NAME):
    return [
        {"pk": f"DEVICE#{device_id}", "sk": "METADATA", "entity": "device", "deviceId": device_id, "name": name,
         "type": "wifi-adapter", "status": "active", "workspaceId": workspace_id, "createdBy": created_by,
         "dataPath": f"s3://{BUCKET}/devices/{device_id}/", "profileImageArtifactId": IMG},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"DEVICE#{device_id}", "entity": "workspace-device", "name": name},
        {"pk": f"DEVICE#{device_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "device-workspace"},
    ]


def artifact_rows(artifact_id, artifact_type, device_ids, s3_key, workspace_id=WS_A, **extra):
    rows = [
        {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA", "entity": "artifact", "artifactId": artifact_id,
         "type": artifact_type, "status": "ready", "s3Bucket": BUCKET, "s3Key": s3_key,
         "sizeBytes": Decimal(100), "deviceIds": set(device_ids), "workspaceId": workspace_id, **extra},
        {"pk": f"WORKSPACE#{workspace_id}", "sk": f"ARTIFACT#{artifact_id}", "entity": "workspace-artifact"},
        {"pk": f"ARTIFACT#{artifact_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "artifact-workspace"},
    ]
    for did in device_ids:
        rows += [
            {"pk": f"DEVICE#{did}", "sk": f"ARTIFACT#{artifact_type}#{artifact_id}", "entity": "device-artifact"},
            {"pk": f"ARTIFACT#{artifact_id}", "sk": f"DEVICE#{did}", "entity": "artifact-device", "name": NAME},
        ]
    return rows


def cve_rows(record_id, cve_id, device_ids):
    rows = fakes.workspace_cve_rows(record_id, cve_id, WS_A, deviceIds=set(device_ids))
    for did in device_ids:
        rows += fakes.link_rows(record_id, did, cve_id)
    return rows


def world():
    rows = []
    rows += membership(WS_A, {OWNER: "owner", MEMBER: "member", MEMBER2: "member", VIEWER: "viewer"})
    rows += membership(WS_B, {OUTSIDER: "owner"})
    rows += device_rows(DEV_A, WS_A, MEMBER)
    rows += device_rows(DEV_A2, WS_A, MEMBER, name="Other adapter")
    rows += device_rows(DEV_B, WS_B, OUTSIDER, name="WS B device")
    rows += artifact_rows(IMG, "image", [DEV_A], f"artifacts/{IMG}/att-2",
                          orphanS3Keys={f"artifacts/{IMG}/att-1"}, mimeType="image/png")
    rows += artifact_rows(FW, "firmware", [DEV_A], f"artifacts/{FW}/att-1", version="1.2", uploadBatchId=BATCH)
    rows += [
        {"pk": f"DEVICE#{DEV_A}", "sk": "FWVER#1.2", "entity": "device-firmware-version", "artifactId": FW},
        {"pk": f"BATCH#{BATCH}", "sk": "METADATA", "entity": "upload-batch", "fileCount": Decimal(2),
         "totalBytes": Decimal(300), "workspaceId": WS_A},
        {"pk": f"BATCH#{BATCH}", "sk": f"ARTIFACT#{FW}", "entity": "batch-artifact"},
        {"pk": f"BATCH#{BATCH}", "sk": f"ARTIFACT#{SHARED}", "entity": "batch-artifact"},
    ]
    rows += artifact_rows(SHARED, "pcap", [DEV_A, DEV_A2], f"artifacts/{SHARED}/att-1")
    rows += artifact_rows(RUNIN, "firmware", [DEV_A], f"devices/{DEV_A}/firmware/0.9/old.bin",
                          version="0.9", migratedFromFirmwareId="fw-old")
    rows += [
        {"pk": f"ARTIFACT#{RUNIN}", "sk": f"RUN#{RUN}", "entity": "artifact-run", "relation": "input"},
        {"pk": f"RUN#{RUN}", "sk": f"ARTIFACT#{RUNIN}", "entity": "run-artifact", "relation": "input"},
        {"pk": f"RUN#{RUN}", "sk": "METADATA", "entity": "run", "workspaceId": WS_A},
        {"pk": f"RUN#{RUN}", "sk": f"DEVICE#{DEV_A}", "entity": "run-device"},
        {"pk": f"DEVICE#{DEV_A}", "sk": f"RUN#{RUN}", "entity": "device-run"},
    ]
    rows += cve_rows(CVE_SHARED, "CVE-2021-0001", [DEV_A, DEV_A2])
    rows += cve_rows(CVE_ONLY, "CVE-2021-0002", [DEV_A])
    rows += [
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "METADATA", "entity": "re-notebook", "sectionIds": ["s1"]},
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "SECTION#s1", "entity": "re-notebook-section", "entryIds": ["e1"]},
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "ENTRY#e1", "entity": "re-notebook-entry", "sectionId": "s1"},
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "ENTRY#e2", "entity": "re-notebook-entry", "sectionId": "s1",
         "deletedAt": "2026-11-01T00:00:00.000000+00:00"},
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "CONTENT#e1", "entity": "re-notebook-content", "doc": "{}"},
        {"pk": f"RENOTEBOOK#{DEV_A}", "sk": "CONTENT#e2", "entity": "re-notebook-content", "doc": "{}"},
        # Another device's notebook, which must be untouched.
        {"pk": f"RENOTEBOOK#{DEV_A2}", "sk": "METADATA", "entity": "re-notebook"},
    ]
    return rows


S3_KEYS = {
    f"artifacts/{IMG}/att-1", f"artifacts/{IMG}/att-2", f"artifacts/{IMG}/abandoned-attempt",
    f"artifacts/{FW}/att-1", f"artifacts/{SHARED}/att-1",
    f"devices/{DEV_A}/firmware/0.9/old.bin", f"devices/{DEV_A}/firmware/0.8/older.bin", f"devices/{DEV_A}/notes.txt",
    f"devices/{DEV_A2}/firmware/1.0/keep.bin",
}
KEPT_S3 = {f"artifacts/{SHARED}/att-1", f"devices/{DEV_A}/firmware/0.9/old.bin",
           f"devices/{DEV_A2}/firmware/1.0/keep.bin"}


def api_event(method, resource, user, device_id=DEV_A, body=None):
    return {
        "httpMethod": method,
        "resource": resource,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": {"deviceId": device_id},
        "queryStringParameters": None,
        "body": json.dumps(body) if body is not None and not isinstance(body, str) else body,
    }


class Context:
    def __init__(self, ms=300_000):
        self.ms = ms

    def get_remaining_time_in_millis(self):
        return self.ms


class DeleteTestCase(unittest.TestCase):
    rows = None

    def setUp(self):
        self.module = fakes.load_lambda("delete-device")
        self.table = Table(self.rows if self.rows is not None else world())
        self.client = fakes.FakeClient(self.table)
        self.s3 = FakeS3(S3_KEYS)
        self.module.dynamodb = fakes.FakeResource(self.table)
        self.module.client = self.client
        self.module.s3 = self.s3
        patcher = mock.patch.object(self.module, "_utcnow", side_effect=lambda: self.now)
        self.now = NOW
        patcher.start()
        self.addCleanup(patcher.stop)
        self.logs = []
        printer = mock.patch("builtins.print", side_effect=lambda line: self.logs.append(json.loads(line)))
        printer.start()
        self.addCleanup(printer.stop)
        self.initial = copy.deepcopy(self.table.items)

    # --- calls ---
    def delete(self, user, device_id=DEV_A, confirm=NAME, body=None):
        payload = body if body is not None else ({"confirmName": confirm} if confirm is not None else {})
        resp = self.module.handler(api_event("DELETE", "/devices/{deviceId}", user, device_id, payload), Context())
        return resp["statusCode"], json.loads(resp["body"])

    def preview(self, user, device_id=DEV_A):
        resp = self.module.handler(api_event("GET", "/devices/{deviceId}/deletion", user, device_id), Context())
        return resp["statusCode"], json.loads(resp["body"])

    def sweep(self):
        return self.module.handler({"source": "aws.events", "detail-type": "Scheduled Event"}, Context())

    # --- state ---
    def rows_mentioning(self, device_id):
        return sorted(k for k in self.table.items if device_id in k[0] or device_id in k[1])

    def tombstone(self, device_id=DEV_A):
        return self.table.items.get((DELETIONS, f"DEVICE#{device_id}"))

    def meta(self, pk):
        return self.table.items.get((pk, "METADATA"))

    def assertUnchanged(self):
        self.assertEqual(self.table.items, self.initial)
        self.assertEqual(self.s3.objects, S3_KEYS)

    def assertFullyDeleted(self):
        self.assertEqual(self.rows_mentioning(DEV_A), [])
        self.assertIsNone(self.tombstone())
        for (pk, sk), item in self.table.items.items():
            self.assertNotIn(DEV_A, item.get("deviceIds") or set(), f"{pk} / {sk} still lists the device")
            fakes.assert_no_empty_sets(item)
        # Files only this device used are gone; files still in use are kept.
        self.assertEqual(self.s3.objects, KEPT_S3)


class SharedRuleTests(unittest.TestCase):
    def test_may_delete_device(self):
        ws_device = {"workspaceId": WS_A, "createdBy": MEMBER}
        self.assertTrue(testbed_authz.may_delete_device("owner", ws_device, OWNER))
        self.assertTrue(testbed_authz.may_delete_device("member", ws_device, MEMBER))
        self.assertFalse(testbed_authz.may_delete_device("member", ws_device, MEMBER2))
        self.assertFalse(testbed_authz.may_delete_device("viewer", ws_device, MEMBER))  # even its creator
        self.assertFalse(testbed_authz.may_delete_device(None, ws_device, MEMBER))
        self.assertFalse(testbed_authz.may_delete_device("member", {"workspaceId": WS_A}, MEMBER))
        self.assertTrue(testbed_authz.may_delete_device("owner", {}, PERSONAL))
        self.assertFalse(testbed_authz.may_delete_device("member", {}, PERSONAL))
        self.assertFalse(testbed_authz.may_delete_device(None, {}, PERSONAL))


class SuccessfulDeletionTests(DeleteTestCase):
    def test_creator_deletes_device_with_all_its_resources(self):
        status, body = self.delete(MEMBER)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["deviceId"], DEV_A)
        self.assertTrue(body["deleted"])
        self.assertFalse(body["cleanupPending"])
        self.assertFullyDeleted()

        # Artifacts only this device used are deleted, rows and mirrors.
        for aid in (IMG, FW):
            self.assertEqual([k for k in self.table.items if aid in k[0] or aid in k[1]], [])
        # The batch keeps its other file; its counters drop by the deleted one.
        batch = self.meta(f"BATCH#{BATCH}")
        self.assertEqual((batch["fileCount"], batch["totalBytes"]), (Decimal(1), Decimal(200)))
        self.assertIn((f"BATCH#{BATCH}", f"ARTIFACT#{SHARED}"), self.table.items)

        # Shared artifacts are kept and only unlinked.
        self.assertEqual(self.meta(f"ARTIFACT#{SHARED}")["deviceIds"], {DEV_A2})
        self.assertIn((f"DEVICE#{DEV_A2}", f"ARTIFACT#pcap#{SHARED}"), self.table.items)
        run_input = self.meta(f"ARTIFACT#{RUNIN}")
        self.assertNotIn("deviceIds", run_input)  # last device: removed, not emptied
        self.assertIn((f"ARTIFACT#{RUNIN}", f"RUN#{RUN}"), self.table.items)
        self.assertIsNotNone(self.meta(f"RUN#{RUN}"))

        # Other devices and their notebook are untouched.
        self.assertIsNotNone(self.meta(f"DEVICE#{DEV_A2}"))
        self.assertIn((f"RENOTEBOOK#{DEV_A2}", "METADATA"), self.table.items)

        events = [log["event"] for log in self.logs]
        self.assertEqual(events, ["device_deletion_started", "device_deleted"])
        self.assertEqual(self.logs[0]["requestedBy"], MEMBER)
        self.assertEqual(self.logs[0]["workspaceId"], WS_A)

    def test_shared_cve_records_are_preserved(self):
        self.assertEqual(self.delete(OWNER)[0], 200)
        shared = self.meta(f"CVE#{CVE_SHARED}")
        self.assertEqual(shared["deviceIds"], {DEV_A2})
        self.assertEqual(shared["version"], Decimal(2))
        self.assertIn((f"CVE#{CVE_SHARED}", f"DEVICE#{DEV_A2}"), self.table.items)
        only = self.meta(f"CVE#{CVE_ONLY}")
        self.assertIsNotNone(only, "a CVE record is never deleted with a device")
        self.assertNotIn("deviceIds", only)
        self.assertEqual(only["version"], Decimal(2))
        # Claims and scope rows of both CVEs stay.
        for record_id, cve_id in ((CVE_SHARED, "CVE-2021-0001"), (CVE_ONLY, "CVE-2021-0002")):
            self.assertIn((f"WORKSPACE#{WS_A}", f"CVE#{record_id}"), self.table.items)
            self.assertIn((f"WORKSPACE#{WS_A}", f"CVEID#{cve_id}"), self.table.items)

    def test_workspace_owner_may_delete_any_device(self):
        self.assertEqual(self.delete(OWNER)[0], 200)
        self.assertFullyDeleted()

    def test_confirmation_ignores_surrounding_whitespace(self):
        self.assertEqual(self.delete(OWNER, confirm=f"  {NAME} ")[0], 200)

    def test_personal_device(self):
        self.table.items.update({(r["pk"], r["sk"]): r for r in fakes.personal_device_rows(DEV_P, PERSONAL, NAME)})
        self.s3.objects.add(f"devices/{DEV_P}/firmware/1/a.bin")
        status, _ = self.delete(PERSONAL, DEV_P)
        self.assertEqual(status, 200)
        self.assertEqual(self.rows_mentioning(DEV_P), [])
        self.assertNotIn(f"devices/{DEV_P}/firmware/1/a.bin", self.s3.objects)


class PermissionTests(DeleteTestCase):
    def test_viewer_is_refused(self):
        status, body = self.delete(VIEWER)
        self.assertEqual(status, 403)
        self.assertIn("Viewers", body["error"])
        self.assertUnchanged()

    def test_member_who_did_not_create_it_is_refused(self):
        status, body = self.delete(MEMBER2)
        self.assertEqual(status, 403)
        self.assertIn("owner or the member who created", body["error"])
        self.assertUnchanged()

    def test_other_workspace_is_refused(self):
        self.assertEqual(self.delete(OUTSIDER)[0], 403)
        self.assertEqual(self.delete(OUTSIDER, DEV_A, confirm=NAME)[0], 403)
        self.assertUnchanged()

    def test_leftover_owner_row_grants_nothing_on_workspace_device(self):
        self.table.items[(f"USER#{OUTSIDER}", f"DEVICE#{DEV_A}")] = {
            "pk": f"USER#{OUTSIDER}", "sk": f"DEVICE#{DEV_A}", "role": "owner"}
        self.initial = copy.deepcopy(self.table.items)
        self.assertEqual(self.delete(OUTSIDER)[0], 403)
        self.assertUnchanged()

    def test_personal_device_of_someone_else_is_refused(self):
        self.table.items.update({(r["pk"], r["sk"]): r for r in fakes.personal_device_rows(DEV_P, PERSONAL, NAME)})
        self.initial = copy.deepcopy(self.table.items)
        self.assertEqual(self.delete(OWNER, DEV_P)[0], 403)
        self.assertUnchanged()

    def test_unknown_device_and_bad_id(self):
        self.assertEqual(self.delete(OWNER, "11111111-1111-4111-8111-0000000000ff")[0], 404)
        self.assertEqual(self.delete(OWNER, "not-a-device")[0], 400)
        self.assertUnchanged()

    def test_role_lost_before_the_transaction_writes_nothing(self):
        def demote(table):
            table.items[(f"USER#{MEMBER}", f"WORKSPACE#{WS_A}")]["role"] = "viewer"
            self.client.before_transact = None
        self.client.before_transact = demote
        status, _ = self.delete(MEMBER)
        self.assertEqual(status, 403)
        self.assertIsNotNone(self.meta(f"DEVICE#{DEV_A}"))
        self.assertIsNone(self.tombstone())

    def test_rename_before_the_transaction_is_a_conflict(self):
        def rename(table):
            table.items[(f"DEVICE#{DEV_A}", "METADATA")]["name"] = "Renamed"
            self.client.before_transact = None
        self.client.before_transact = rename
        status, body = self.delete(OWNER)
        self.assertEqual(status, 409)
        self.assertEqual(body["code"], "conflict")
        self.assertIsNotNone(self.meta(f"DEVICE#{DEV_A}"))
        self.assertIsNone(self.tombstone())


class ConfirmationTests(DeleteTestCase):
    def test_wrong_name_is_refused(self):
        for confirm in ("ALFA", NAME.lower(), "Other adapter"):
            status, body = self.delete(OWNER, confirm=confirm)
            self.assertEqual(status, 400)
            self.assertEqual(body["code"], "confirmation_mismatch")
        self.assertUnchanged()

    def test_missing_or_malformed_confirmation(self):
        self.assertEqual(self.delete(OWNER, confirm=None)[1]["code"], "confirmation_required")
        self.assertEqual(self.delete(OWNER, body={"confirmName": 3})[1]["code"], "confirmation_required")
        self.assertEqual(self.delete(OWNER, body={"confirmName": "   "})[0], 400)
        self.assertEqual(self.delete(OWNER, body="{not json")[0], 400)
        self.assertEqual(self.delete(OWNER, body=[NAME])[0], 400)
        self.assertUnchanged()

    def test_viewer_learns_nothing_from_confirmation(self):
        # Authorization comes first, so a wrong name doesn't tell a viewer
        # (or another workspace) anything about the device.
        self.assertEqual(self.delete(VIEWER, confirm="wrong")[0], 403)
        self.assertEqual(self.delete(OUTSIDER, confirm="wrong")[0], 403)


class RepeatTests(DeleteTestCase):
    def test_repeated_request_after_completion(self):
        self.assertEqual(self.delete(MEMBER)[0], 200)
        after = copy.deepcopy(self.table.items)
        status, _ = self.delete(MEMBER)
        self.assertEqual(status, 404)
        self.assertEqual(self.table.items, after)

    def test_repeated_request_while_another_holds_the_lease(self):
        self.s3.refuse = {f"artifacts/{IMG}/att-2"}
        self.assertEqual(self.delete(MEMBER)[0], 202)
        # Someone (the sweep) takes the lease.
        self.table.items[(DELETIONS, f"DEVICE#{DEV_A}")]["leaseUntil"] = (NOW + timedelta(minutes=5)).isoformat(
            timespec="microseconds")
        self.table.items[(DELETIONS, f"DEVICE#{DEV_A}")]["leaseId"] = "someone-else"
        before = copy.deepcopy(self.table.items)
        status, body = self.delete(MEMBER)
        self.assertEqual(status, 202)
        self.assertTrue(body["cleanupPending"])
        self.assertEqual(self.table.items, before)


class PartialFailureTests(DeleteTestCase):
    def fail_first_attempt(self):
        self.s3.refuse = {f"artifacts/{IMG}/att-2"}
        status, body = self.delete(MEMBER)
        self.assertEqual(status, 202, body)
        self.assertTrue(body["cleanupPending"])
        # The device is gone for everyone, and what remains is recorded.
        self.assertIsNone(self.meta(f"DEVICE#{DEV_A}"))
        self.assertNotIn((f"WORKSPACE#{WS_A}", f"DEVICE#{DEV_A}"), self.table.items)
        tombstone = self.tombstone()
        self.assertIn("AccessDenied", tombstone["lastError"])
        self.assertNotIn("leaseUntil", tombstone)  # released for the sweep
        # The image wasn't deleted: its record (which holds its keys) stays.
        self.assertIsNotNone(self.meta(f"ARTIFACT#{IMG}"))
        self.assertIn(f"artifacts/{IMG}/att-2", self.s3.objects)
        self.assertIn("device_deletion_incomplete", [log["event"] for log in self.logs])
        self.s3.refuse = set()

    def test_sweep_finishes_a_failed_cleanup(self):
        self.fail_first_attempt()
        self.assertEqual(self.sweep(), {"finished": 1, "pending": 0})
        self.assertFullyDeleted()

    def test_user_retry_finishes_a_failed_cleanup(self):
        self.fail_first_attempt()
        self.assertEqual(self.delete(MEMBER, confirm="wrong")[0], 400)
        status, body = self.delete(MEMBER)
        self.assertEqual(status, 200, body)
        self.assertFullyDeleted()

    def test_only_someone_allowed_may_resume(self):
        self.fail_first_attempt()
        for user in (VIEWER, MEMBER2, OUTSIDER):
            self.assertEqual(self.delete(user)[0], 404)
        self.assertIsNotNone(self.tombstone())
        self.assertEqual(self.delete(OWNER)[0], 200)
        self.assertFullyDeleted()

    def test_time_running_out_leaves_the_rest_to_the_sweep(self):
        with mock.patch.object(self.module, "API_BUDGET_SECONDS", 0):
            status, body = self.delete(MEMBER)
        self.assertEqual(status, 202)
        self.assertTrue(body["cleanupPending"])
        self.assertIn("device_deletion_pending", [log["event"] for log in self.logs])
        self.sweep()
        self.assertFullyDeleted()

    def test_kept_files_stay_protected_across_attempts(self):
        # Fail after the kept artifacts are unlinked: the next attempt can no
        # longer find them from the device, but must still keep their files.
        original = self.module._unlink_cve

        def fail_on_first(*args, **kwargs):
            self.module._unlink_cve = original
            raise RuntimeError("crash")
        self.module._unlink_cve = fail_on_first
        self.assertEqual(self.delete(MEMBER)[0], 202)
        self.assertNotIn((f"DEVICE#{DEV_A}", f"ARTIFACT#firmware#{RUNIN}"), self.table.items)
        self.assertIn(f"devices/{DEV_A}/firmware/0.9/old.bin", self.tombstone()["protectedS3Keys"])
        self.sweep()
        self.assertFullyDeleted()

    def test_device_prefix_is_retried_after_every_row_is_gone(self):
        self.s3.refuse = {f"devices/{DEV_A}/notes.txt"}
        self.assertEqual(self.delete(MEMBER)[0], 202)
        # Every row is gone; only the object (and the tombstone) remain.
        self.assertEqual(self.rows_mentioning(DEV_A), [(DELETIONS, f"DEVICE#{DEV_A}")])
        self.assertIn(f"devices/{DEV_A}/notes.txt", self.s3.objects)
        self.s3.refuse = set()
        self.assertEqual(self.sweep(), {"finished": 1, "pending": 0})
        self.assertFullyDeleted()

    def test_sweep_skips_a_live_lease_and_takes_a_lapsed_one(self):
        with mock.patch.object(self.module, "API_BUDGET_SECONDS", 0):
            self.delete(MEMBER)
        self.table.items[(DELETIONS, f"DEVICE#{DEV_A}")]["leaseUntil"] = (NOW + timedelta(minutes=5)).isoformat(
            timespec="microseconds")
        self.assertEqual(self.sweep(), {"finished": 0, "pending": 0})
        self.assertIsNotNone(self.tombstone())
        self.now = NOW + timedelta(minutes=6)
        self.assertEqual(self.sweep(), {"finished": 1, "pending": 0})
        self.assertFullyDeleted()

    def test_concurrent_cve_change_is_retried(self):
        calls = {"n": 0}

        def link_another_device(table):
            # Between cleanup's read of the CVE and its write, another
            # device gets linked: the transaction fails, then succeeds.
            calls["n"] += 1
            meta = table.items[(f"CVE#{CVE_ONLY}", "METADATA")]
            if calls["n"] > 1 and meta.get("deviceIds") == {DEV_A}:
                meta["deviceIds"] = {DEV_A, DEV_A2}
                self.client.before_transact = None
        self.client.before_transact = link_another_device
        self.assertEqual(self.delete(MEMBER)[0], 200)
        self.assertEqual(self.meta(f"CVE#{CVE_ONLY}")["deviceIds"], {DEV_A2})


class PreviewTests(DeleteTestCase):
    def test_counts(self):
        status, body = self.preview(MEMBER)
        self.assertEqual(status, 200)
        self.assertEqual(body["name"], NAME)
        self.assertEqual(body["workspaceId"], WS_A)
        self.assertEqual(body["resources"], {
            "firmware": 1, "images": 1, "otherArtifacts": 0, "sharedArtifacts": 2,
            "cves": 2, "runs": 1, "notebookSections": 1, "notebookEntries": 1,
        })
        self.assertUnchanged()

    def test_permissions(self):
        self.assertEqual(self.preview(VIEWER)[0], 403)
        self.assertEqual(self.preview(MEMBER2)[0], 403)
        self.assertEqual(self.preview(OUTSIDER)[0], 403)
        self.assertEqual(self.preview(OWNER)[0], 200)
        self.assertEqual(self.preview(OWNER, "11111111-1111-4111-8111-0000000000ff")[0], 404)
        self.assertUnchanged()


class CanDeleteTests(unittest.TestCase):
    """canDelete on GET /devices/{deviceId} (list-devices)."""

    def setUp(self):
        self.module = fakes.load_lambda("list-devices")
        rows = world() + fakes.personal_device_rows(DEV_P, PERSONAL, NAME)
        self.module.dynamodb = fakes.FakeResource(Table(rows))

    def can_delete(self, user, device_id=DEV_A):
        event = api_event("GET", "/devices/{deviceId}", user, device_id)
        resp = self.module.handler(event, None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return json.loads(resp["body"])["canDelete"]

    def test_can_delete(self):
        self.assertTrue(self.can_delete(OWNER))
        self.assertTrue(self.can_delete(MEMBER))
        self.assertFalse(self.can_delete(MEMBER2))
        self.assertFalse(self.can_delete(VIEWER))
        self.assertTrue(self.can_delete(PERSONAL, DEV_P))


if __name__ == "__main__":
    unittest.main()
