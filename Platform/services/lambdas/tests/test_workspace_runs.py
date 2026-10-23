"""Workspace runs: scope of a run, its inputs, listings, detail, logs,
cancellation, outputs and scripts, with DynamoDB, S3, Batch and CloudWatch
Logs replaced by in-memory fakes.

The world is test_workspace_artifacts': W1 has USER (owner) and MEMBER; W2
has W2_OWNER; OUTSIDER belongs to neither. Here W1 also has MEMBER2, so a
member who neither started a run nor owns the workspace can be tested. D1 and
D2 are W1 devices, D3 is a W2 device, DP is USER's personal device.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import base64
import copy
import json
import os
import re
import unittest
from decimal import Decimal
from unittest import mock

from botocore.exceptions import ClientError

import test_workspace_artifacts as wa
from test_workspace_artifacts import D1, D2, D3, DP, MEMBER, OUTSIDER, SHA, USER, W1, W2, W2_OWNER

os.environ.setdefault("CODEBUILD_PROJECT", "builds")
os.environ.setdefault("BUILDKIT_KEY", "buildkit.zip")
os.environ.setdefault("CATALOG_KEY", "catalog.json")

MEMBER2 = "user-member2"
MOD_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"  # USER's private script
MOD_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"  # MEMBER's private script
PRICING = {"fargate": {"vcpuHour": 0.04, "gbHour": 0.004}, "fargateSpot": {"vcpuHour": 0.012, "gbHour": 0.0013},
           "ec2": {"vcpuHour": 0.05, "gbHour": 0.005}, "minBillSeconds": 60}
EMAILS = {USER: "ipule@example.com", MEMBER: "justin@example.com", MEMBER2: "member2@example.com"}

# The transactions in runs-api also check that the workspace exists.
wa.CONDITIONS.setdefault("attribute_exists(pk)", lambda item, v, n: item is not None)


def conditional_failure(operation):
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, operation)


class RunsTable(wa.FakeTable):
    """FakeTable plus the writes the run Lambdas make: put_item, a batch
    writer, and update_item for the SET / ADD expressions they use."""

    def put_item(self, Item, ConditionExpression=None, **kwargs):
        key = (Item["pk"], Item["sk"])
        if not _condition(self.items.get(key), ConditionExpression, {}, {}):
            raise conditional_failure("PutItem")
        self.items[key] = copy.deepcopy(Item)
        return {}

    def delete_item(self, Key, **kwargs):
        self.items.pop((Key["pk"], Key["sk"]), None)
        return {}

    def batch_writer(self):
        table = self

        class Writer:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def put_item(self, Item):
                table.items[(Item["pk"], Item["sk"])] = copy.deepcopy(Item)

        return Writer()

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues=None, ConditionExpression=None,
                    ExpressionAttributeNames=None, ReturnValues=None):
        key = (Key["pk"], Key["sk"])
        values, names = ExpressionAttributeValues or {}, ExpressionAttributeNames or {}
        if not _condition(self.items.get(key), ConditionExpression, values, names):
            raise conditional_failure("UpdateItem")
        item = self.items.setdefault(key, {"pk": Key["pk"], "sk": Key["sk"]})
        for clause, body in re.findall(r"(SET|ADD|REMOVE)\s+(.*?)(?=\s+(?:SET|ADD|REMOVE)\s|$)", UpdateExpression):
            for part in re.split(r",\s*(?![^()]*\))", body):
                if clause == "SET":
                    attr, value = (x.strip() for x in part.split("=", 1))
                    attr = names.get(attr, attr)
                    if value.startswith("if_not_exists("):
                        _, default = (x.strip() for x in value[len("if_not_exists("):-1].split(","))
                        item.setdefault(attr, values[default])
                    else:
                        item[attr] = values[value]
                elif clause == "ADD":
                    attr, value = part.split()
                    attr, value = names.get(attr, attr), values[value]
                    item[attr] = item.get(attr, set()) | value if isinstance(value, set) else item.get(attr, 0) + value
                else:
                    item.pop(names.get(part.strip(), part.strip()), None)
        return {"Attributes": copy.deepcopy(item)} if ReturnValues == "ALL_NEW" else {}


def _condition(item, condition, values, names):
    if condition is None:
        return True
    if condition == "attribute_not_exists(pk)":
        return item is None
    if condition == "attribute_exists(pk)":
        return item is not None
    if condition.startswith("attribute_not_exists(files)"):
        return True  # the output caps; never reached in these tests
    match = re.fullmatch(r"(#?\w+) = (:\w+)", condition)
    assert match, condition
    return item is not None and item.get(names.get(match[1], match[1])) == values[match[2]]


def run_event(user, method, resource, body=None, path=None, query=None):
    return {
        "resource": resource, "httpMethod": method,
        "requestContext": {"authorizer": {"claims": {"sub": user}}},
        "pathParameters": path, "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
    }


def script(module_id, owner, name):
    return [
        {"pk": f"MODULE#{module_id}", "sk": "METADATA", "entity": "module", "moduleId": module_id, "name": name,
         "runtime": "cloud", "latestVersion": 1, "latestReadyVersion": 1, "createdBy": owner},
        {"pk": f"MODULE#{module_id}", "sk": "VERSION#0001", "entity": "module-version", "version": 1,
         "status": "ready", "imageUri": f"repo@sha256:{module_id}", "jobDefinitionArn": f"jobdef-{module_id}",
         "sourceKey": f"scripts/{module_id}/1/a", "createdBy": owner},
        {"pk": f"USER#{owner}", "sk": f"MODULE#{module_id}", "entity": "user-module", "role": "owner", "name": name},
        {"pk": f"MODULE#{module_id}", "sk": f"USER#{owner}", "entity": "module-user", "role": "owner"},
    ]


def runs_world():
    rows = wa.world() + wa.membership(MEMBER2, W1, "member")
    for row in rows:
        if row["pk"].startswith("WORKSPACE#") and row["sk"].startswith("USER#"):
            row["email"] = EMAILS.get(row["sk"][len("USER#"):])
    return rows + script(MOD_USER, USER, "USER's analyser") + script(MOD_MEMBER, MEMBER, "MEMBER's analyser")


class RunsTestCase(wa.WorldTestCase):
    def setUp(self):
        self.table = RunsTable(runs_world())
        self.client = wa.FakeClient(self.table)
        self.modules = {}

    def lam(self, name):
        fresh = name not in self.modules
        module = super().lam(name)
        if fresh and name == "runs-api":
            module.QUEUES = {"economy": "queue-economy", "standard": "queue-standard"}
            module.PRICING = PRICING
            module.batch = mock.Mock()
            module.batch.submit_job.return_value = {"jobId": "job-1"}
            module.logs = mock.Mock()
            module.logs.get_log_events.return_value = {"events": [{"message": "unit 1 done\n"}]}
        if fresh and name == "runs-manifest":
            module.s3.head_object.side_effect = lambda **kw: {
                "ContentLength": 5, "ChecksumSHA256": base64.b64encode(bytes.fromhex(SHA)).decode()}
        return module

    # --- runs-api calls --------------------------------------------------------

    def runs(self, user, method, resource, body=None, path=None, query=None):
        resp = self.lam("runs-api").handler(run_event(user, method, resource, body, path, query), None)
        return resp["statusCode"], json.loads(resp["body"])

    def run_body(self, inputs, module_id=MOD_USER, workspace_id=None, **extra):
        body = {"moduleId": module_id, "inputs": inputs, "mode": "map", "class": "economy", "size": "S",
                "timeoutMinutes": 30, **extra}
        if workspace_id:
            body["workspaceId"] = workspace_id
        return body

    def start(self, user, inputs, module_id=MOD_USER, workspace_id=None, expect=201):
        status, body = self.runs(user, "POST", "/runs", self.run_body(inputs, module_id, workspace_id))
        self.assertEqual(status, expect, body)
        return body.get("run", body)

    def detail(self, user, run_id):
        return self.runs(user, "GET", "/runs/{runId}", path={"runId": run_id})

    def cancel(self, user, run_id):
        return self.runs(user, "POST", "/runs/{runId}/cancel", path={"runId": run_id})

    def list_runs(self, user, workspace_id=None):
        query = {"workspaceId": workspace_id} if workspace_id else None
        return self.runs(user, "GET", "/runs", query=query)

    def run_meta(self, run_id):
        return self.table.items[(f"RUN#{run_id}", "METADATA")]

    def run_token(self):
        env = self.lam("runs-api").batch.submit_job.call_args.kwargs["containerOverrides"]["environment"]
        return next(v["value"] for v in env if v["name"] == "RUN_TOKEN")

    def started_member_run(self):
        """MEMBER starts a run on a W1 device's files; returns its id."""
        self.upload(USER, [D1], artifact_type="pcap")
        return self.start(MEMBER, {"deviceId": D1}, MOD_MEMBER, W1)["runId"]


# --- 1. Personal runs are unchanged --------------------------------------------------


class PersonalRunTests(RunsTestCase):
    def test_personal_run_rows_and_response_are_unchanged(self):
        aid = self.upload(USER, [DP], artifact_type="pcap")
        run = self.start(USER, {"deviceId": DP})
        rid = run["runId"]
        self.assertNotIn("workspaceId", run)
        self.assertNotIn("createdBy", run)
        meta = self.run_meta(rid)
        self.assertNotIn("workspaceId", meta)
        self.assertEqual((meta["createdBy"], meta["status"], meta["inputCount"]), (USER, "queued", 1))
        self.assertEqual(self.table.items[(f"USER#{USER}", f"RUN#{rid}")]["entity"], "user-run")
        self.assertEqual(self.table.items[(f"RUN#{rid}", f"USER#{USER}")]["entity"], "run-user")
        self.assertFalse([k for k in self.table.items if "WORKSPACE#" in k[0] + k[1] and rid in k[0] + k[1]])
        self.assertIn((f"RUN#{rid}", f"ARTIFACT#{aid}"), self.table.items)
        self.assertEqual(self.lam("runs-api").batch.submit_job.call_args.kwargs["tags"], {"userId": USER, "runId": rid})
        # No transaction for a personal run: written exactly as before.
        self.assertFalse([c for c in self.client.calls if any(f"RUN#{rid}" in json.dumps(t) for t in c)])

    def test_personal_list_detail_cancel(self):
        self.upload(USER, [DP], artifact_type="pcap")
        rid = self.start(USER, {"deviceId": DP})["runId"]
        status, body = self.list_runs(USER)
        self.assertEqual((status, [r["runId"] for r in body["runs"]]), (200, [rid]))
        status, body = self.detail(USER, rid)
        self.assertEqual(status, 200)
        self.assertTrue(body["canCancel"])
        self.assertNotIn("createdByEmail", body["run"])
        self.assertEqual(self.cancel(USER, rid)[0], 200)
        self.assertEqual(self.detail(MEMBER, rid)[0], 404)

    def test_personal_sources_still_work(self):
        aid = self.upload(USER, None, artifact_type="log")
        batch = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]["uploadBatchId"]
        for inputs in ({"batchId": batch}, {"artifactIds": [aid]}, {"type": "log"}):
            status, body = self.runs(USER, "POST", "/runs/estimate", self.run_body(inputs))
            self.assertEqual((status, body["inputCount"]), (200, 1), inputs)

    def test_personal_run_never_uses_workspace_files(self):
        ws = self.upload(USER, [D1], artifact_type="pcap")
        status, body = self.runs(USER, "POST", "/runs/estimate", self.run_body({"artifactIds": [ws]}))
        self.assertEqual((status, body["inputCount"]), (200, 0))
        status, body = self.runs(USER, "POST", "/runs/estimate", self.run_body({"deviceId": D1}))
        self.assertEqual(status, 400)
        self.assertIn("different workspace", body["error"])

    def test_personal_list_hides_workspace_runs_even_with_a_stale_owner_row(self):
        rid = self.started_member_run()
        wa.add_rows(self.table, [{"pk": f"USER#{MEMBER}", "sk": f"RUN#{rid}", "entity": "user-run", "role": "owner"}])
        self.assertEqual(self.list_runs(MEMBER)[1]["runs"], [])


# --- 2. A workspace member starts an analysis ----------------------------------------


class WorkspaceStartTests(RunsTestCase):
    def test_member_starts_run_on_workspace_device(self):
        aid = self.upload(USER, [D1], artifact_type="pcap")
        run = self.start(MEMBER, {"deviceId": D1}, MOD_MEMBER, W1)
        rid = run["runId"]
        self.assertEqual((run["workspaceId"], run["createdBy"], run["inputCount"]), (W1, MEMBER, 1))
        meta = self.run_meta(rid)
        self.assertEqual((meta["workspaceId"], meta["createdBy"], meta["status"]), (W1, MEMBER, "queued"))
        link = self.table.items[(f"WORKSPACE#{W1}", f"RUN#{rid}")]
        self.assertEqual((link["entity"], link["createdBy"]), ("workspace-run", MEMBER))
        self.assertEqual(self.table.items[(f"RUN#{rid}", f"WORKSPACE#{W1}")]["entity"], "run-workspace")
        # No ownership rows for a workspace run.
        self.assertFalse([k for k in self.table.items if k[0].startswith("USER#") and k[1] == f"RUN#{rid}"])
        self.assertFalse([k for k in self.table.items if k[0] == f"RUN#{rid}" and k[1].startswith("USER#")])
        self.assertIn((f"RUN#{rid}", f"ARTIFACT#{aid}"), self.table.items)
        self.assertIn((f"DEVICE#{D1}", f"RUN#{rid}"), self.table.items)
        # The creator's budget pays.
        self.assertGreater(self.table.items[(f"USER#{MEMBER}", "BUDGET")]["held"], 0)
        self.assertNotIn((f"USER#{USER}", "BUDGET"), self.table.items)
        tags = self.lam("runs-api").batch.submit_job.call_args.kwargs["tags"]
        self.assertEqual(tags, {"userId": MEMBER, "runId": rid, "workspaceId": W1})
        # The scope rows were written with a membership re-check.
        [txn] = [c for c in self.client.calls if any(f"RUN#{rid}" in json.dumps(t) for t in c)]
        self.assertEqual([next(iter(t)) for t in txn], ["Put", "Put", "Put", "ConditionCheck", "ConditionCheck"])

    def test_every_input_source_in_a_workspace(self):
        aid = self.upload(MEMBER, [D1], artifact_type="log")
        batch = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]["uploadBatchId"]
        self.upload(MEMBER, None, artifact_type="log")  # personal: never in W1's runs
        for inputs in ({"batchId": batch}, {"deviceId": D1}, {"artifactIds": [aid]}, {"type": "log"}, {}):
            status, body = self.runs(MEMBER, "POST", "/runs/estimate", self.run_body(inputs, MOD_MEMBER, W1))
            self.assertEqual((status, body["inputCount"]), (200, 1), inputs)
        rid = self.start(MEMBER, {"batchId": batch}, MOD_MEMBER, W1)["runId"]
        # An earlier workspace run's outputs as inputs.
        self.assertEqual(self.runs(MEMBER, "POST", "/runs/estimate",
                                   self.run_body({"runId": rid}, MOD_MEMBER, W1))[0], 200)

    def test_membership_removed_during_start_is_refused_and_released(self):
        self.upload(USER, [D1], artifact_type="pcap")
        runs = self.lam("runs-api")
        original = runs._resolve_inputs

        def remove_membership(*args):
            result = original(*args)
            del self.table.items[(f"USER#{MEMBER}", f"WORKSPACE#{W1}")]
            return result

        with mock.patch.object(runs, "_resolve_inputs", remove_membership):
            status, body = self.runs(MEMBER, "POST", "/runs", self.run_body({"deviceId": D1}, MOD_MEMBER, W1))
        self.assertEqual((status, body["error"]), (404, "Workspace not found"))
        self.assertEqual(self.table.items[(f"USER#{MEMBER}", "BUDGET")]["held"], 0)
        self.assertFalse([k for k in self.table.items if k[0].startswith("RUN#")])
        runs.batch.submit_job.assert_not_called()


# --- 3. Another member views the results ---------------------------------------------


class WorkspaceViewTests(RunsTestCase):
    def test_other_members_list_and_view_the_run(self):
        rid = self.started_member_run()
        for user in (USER, MEMBER, MEMBER2):
            status, body = self.list_runs(user, W1)
            self.assertEqual((status, [r["runId"] for r in body["runs"]], body["workspaceId"]), (200, [rid], W1))
        status, body = self.detail(USER, rid)
        self.assertEqual(status, 200)
        self.assertEqual((body["run"]["workspaceId"], body["run"]["createdBy"], body["run"]["createdByEmail"]),
                         (W1, MEMBER, EMAILS[MEMBER]))
        self.assertEqual(body["jobs"]["counts"], {"queued": 1})

    def test_other_member_reads_a_job_log(self):
        rid = self.started_member_run()
        self.table.items[(f"RUN#{rid}", "CHILD#00000")]["logStreamName"] = "stream-1"
        status, body = self.runs(MEMBER2, "GET", "/runs/{runId}/children/{index}/log",
                                 path={"runId": rid, "index": "0"})
        self.assertEqual((status, body["lines"]), (200, ["unit 1 done"]))

    def test_workspace_list_is_only_that_workspace(self):
        rid = self.started_member_run()
        self.upload(USER, [DP], artifact_type="pcap")
        personal = self.start(USER, {"deviceId": DP})["runId"]
        self.assertEqual([r["runId"] for r in self.list_runs(USER, W1)[1]["runs"]], [rid])
        self.assertEqual([r["runId"] for r in self.list_runs(USER)[1]["runs"]], [personal])
        # A forged WORKSPACE#/RUN# row doesn't pull another scope's run in.
        wa.add_rows(self.table, [{"pk": f"WORKSPACE#{W1}", "sk": f"RUN#{personal}", "entity": "workspace-run"}])
        self.assertEqual([r["runId"] for r in self.list_runs(USER, W1)[1]["runs"]], [rid])


# --- 4. Outputs belong to the workspace ----------------------------------------------


class WorkspaceOutputTests(RunsTestCase):
    def produce_output(self, rid):
        """Runs the job side through runs-manifest: one output for unit 0."""
        manifest = self.lam("runs-manifest")
        token = self.run_token()
        unit = self.table.items[(f"RUN#{rid}", "CHILD#00000")]["units"][0]["unitId"]

        def call(resource, body):
            resp = manifest.handler({"resource": resource, "headers": {"X-Run-Token": token},
                                     "body": json.dumps({"runId": rid, "childIndex": 0, **body})}, None)
            self.assertEqual(resp["statusCode"], 200, resp["body"])
            return json.loads(resp["body"])

        call("/manifest", {})
        [out] = call("/outputs/presign", {"unitId": unit, "attempt": "1",
                                          "files": [{"path": "report.json", "sizeBytes": 5, "sha256": SHA}]})["files"]
        call("/outputs/complete", {"unitId": unit, "status": "succeeded",
                                   "outputs": [{"artifactId": out["artifactId"], "attemptId": out["attemptId"]}]})
        return out["artifactId"]

    def test_workspace_run_outputs_are_workspace_artifacts(self):
        rid = self.started_member_run()
        aid = self.produce_output(rid)
        meta = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]
        self.assertEqual((meta["workspaceId"], meta["createdBy"], meta["status"]), (W1, MEMBER, "ready"))
        link = self.table.items[(f"WORKSPACE#{W1}", f"ARTIFACT#{aid}")]
        self.assertEqual((link["entity"], link["createdBy"]), ("workspace-artifact", MEMBER))
        self.assertIn((f"ARTIFACT#{aid}", f"WORKSPACE#{W1}"), self.table.items)
        self.assertFalse([k for k in self.table.items if k[1] == f"ARTIFACT#{aid}" and k[0].startswith("USER#")])

    def test_other_members_see_and_download_outputs_outsiders_do_not(self):
        rid = self.started_member_run()
        aid = self.produce_output(rid)
        listing = self.lam("artifacts-list")
        get = self.lam("artifacts-get")
        for user in (USER, MEMBER2):
            resp = listing.handler(wa.event(user, "/artifacts", query={"runId": rid}), None)
            self.assertEqual([a["artifactId"] for a in wa.response_body(resp)["artifacts"]], [aid])
            resp = get.handler(wa.event(user, "/artifacts/{artifactId}/download", path={"artifactId": aid}), None)
            self.assertEqual(resp["statusCode"], 200)
        resp = listing.handler(wa.event(USER, "/artifacts", query={"workspaceId": W1, "type": "log"}), None)
        self.assertIn(aid, [a["artifactId"] for a in wa.response_body(resp)["artifacts"]])
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(listing.handler(wa.event(user, "/artifacts", query={"runId": rid}), None)["statusCode"], 404)
            self.assertEqual(get.handler(wa.event(user, "/artifacts/{artifactId}", path={"artifactId": aid}),
                                         None)["statusCode"], 404)
        # Not personal: absent from the creator's personal listing.
        resp = listing.handler(wa.event(MEMBER, "/artifacts"), None)
        self.assertNotIn(aid, [a["artifactId"] for a in wa.response_body(resp)["artifacts"]])

    def test_personal_run_outputs_stay_personal(self):
        self.upload(USER, [DP], artifact_type="pcap")
        rid = self.start(USER, {"deviceId": DP})["runId"]
        aid = self.produce_output(rid)
        self.assertNotIn("workspaceId", self.table.items[(f"ARTIFACT#{aid}", "METADATA")])
        self.assertIn((f"USER#{USER}", f"ARTIFACT#{aid}"), self.table.items)
        resp = self.lam("artifacts-list").handler(wa.event(USER, "/artifacts", query={"runId": rid}), None)
        self.assertEqual([a["artifactId"] for a in wa.response_body(resp)["artifacts"]], [aid])


# --- 5. Unauthorized users ------------------------------------------------------------


class UnauthorizedTests(RunsTestCase):
    def test_outsiders_get_not_found_everywhere(self):
        rid = self.started_member_run()
        self.table.items[(f"RUN#{rid}", "CHILD#00000")]["logStreamName"] = "stream-1"
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(self.detail(user, rid)[0], 404)
            self.assertEqual(self.cancel(user, rid)[0], 404)
            self.assertEqual(self.runs(user, "GET", "/runs/{runId}/children/{index}/log",
                                       path={"runId": rid, "index": "0"})[0], 404)
            self.assertEqual(self.list_runs(user, W1), (404, {"error": "Workspace not found"}))
            status, _ = self.runs(user, "POST", "/runs/estimate", self.run_body({"deviceId": D1}, workspace_id=W1))
            self.assertEqual(status, 404)
        self.lam("runs-api").logs.get_log_events.assert_not_called()

    def test_stale_owner_row_grants_nothing_on_a_workspace_run(self):
        rid = self.started_member_run()
        wa.add_rows(self.table, [
            {"pk": f"USER#{OUTSIDER}", "sk": f"RUN#{rid}", "entity": "user-run", "role": "owner"},
            {"pk": f"RUN#{rid}", "sk": f"USER#{OUTSIDER}", "entity": "run-user", "role": "owner"},
        ])
        self.assertEqual(self.detail(OUTSIDER, rid)[0], 404)
        self.assertEqual(self.cancel(OUTSIDER, rid)[0], 404)
        resp = self.lam("artifacts-list").handler(wa.event(OUTSIDER, "/artifacts", query={"runId": rid}), None)
        self.assertEqual(resp["statusCode"], 404)

    def test_access_ends_with_membership(self):
        rid = self.started_member_run()
        del self.table.items[(f"USER#{MEMBER}", f"WORKSPACE#{W1}")]
        self.assertEqual(self.detail(MEMBER, rid)[0], 404)
        self.assertEqual(self.cancel(MEMBER, rid)[0], 404)  # even as its creator
        self.assertEqual(self.list_runs(MEMBER, W1)[0], 404)
        self.assertEqual(self.runs(MEMBER, "POST", "/runs/estimate",
                                   self.run_body({"deviceId": D1}, MOD_MEMBER, W1))[0], 404)
        resp = self.lam("artifacts-list").handler(wa.event(MEMBER, "/artifacts", query={"runId": rid}), None)
        self.assertEqual(resp["statusCode"], 404)

    def test_invalid_workspace_ids(self):
        for bad in ("", "nope", f"{W1}#x", None):
            self.assertEqual(self.runs(USER, "GET", "/runs", query={"workspaceId": bad})[0], 400, bad)
            self.assertEqual(self.runs(USER, "POST", "/runs/estimate", self.run_body({}, workspaceId=bad))[0], 400, bad)


# --- 6. Cross-workspace isolation ------------------------------------------------------


class IsolationTests(RunsTestCase):
    def estimate(self, user, inputs, workspace_id=W1, module_id=MOD_USER):
        return self.runs(user, "POST", "/runs/estimate", self.run_body(inputs, module_id, workspace_id))

    def test_other_workspace_device_is_not_found_for_non_members(self):
        self.assertEqual(self.estimate(USER, {"deviceId": D3}), (404, {"error": "Device not found"}))

    def test_other_scope_sources_are_refused_for_members_of_both(self):
        wa.add_rows(self.table, wa.membership(USER, W2, "member"))
        w2 = self.upload(USER, [D3], artifact_type="pcap")
        personal = self.upload(USER, [DP], artifact_type="pcap")
        for aid in (w2, personal):
            batch = self.table.items[(f"ARTIFACT#{aid}", "METADATA")]["uploadBatchId"]
            status, body = self.estimate(USER, {"batchId": batch})
            self.assertEqual(status, 400)
            self.assertIn("different workspace", body["error"])
        for device in (D3, DP):
            self.assertEqual(self.estimate(USER, {"deviceId": device})[0], 400)
        personal_run = self.start(USER, {"deviceId": DP})["runId"]
        self.assertEqual(self.estimate(USER, {"runId": personal_run})[0], 400)
        w2_run = self.start(USER, {"deviceId": D3}, workspace_id=W2)["runId"]
        self.assertEqual(self.estimate(USER, {"runId": w2_run})[0], 400)
        # And back: a W1 run can't feed a W2 or personal run.
        self.upload(USER, [D1], artifact_type="pcap")
        w1_run = self.start(USER, {"deviceId": D1}, workspace_id=W1)["runId"]
        self.assertEqual(self.estimate(USER, {"runId": w1_run}, workspace_id=W2)[0], 400)
        self.assertEqual(self.estimate(USER, {"runId": w1_run}, workspace_id=None)[0], 400)

    def test_known_artifact_ids_from_another_scope_are_refused(self):
        ws = self.upload(USER, [D1], artifact_type="pcap")
        wa.add_rows(self.table, wa.membership(W2_OWNER, W1, "member"))
        other = self.upload(W2_OWNER, [D3], artifact_type="pcap")
        personal = self.upload(USER, [DP], artifact_type="pcap")
        for extra in (other, personal, "99999999-9999-4999-8999-999999999999"):
            status, body = self.estimate(USER, {"artifactIds": [ws, extra]})
            self.assertEqual((status, body["error"]), (400, "1 of the selected files aren't in this workspace"))
        self.assertEqual(self.estimate(USER, {"artifactIds": [ws]})[1]["inputCount"], 1)

    def test_filter_source_only_sees_the_workspace(self):
        wa.add_rows(self.table, wa.membership(USER, W2, "member"))
        self.upload(USER, [D1], artifact_type="pcap")
        self.upload(USER, [D3], artifact_type="pcap")
        self.upload(USER, [DP], artifact_type="pcap")
        self.assertEqual(self.estimate(USER, {"type": "pcap"})[1]["inputCount"], 1)
        self.assertEqual(self.estimate(USER, {"type": "pcap"}, workspace_id=None)[1]["inputCount"], 1)

    def test_workspace_batches_listing(self):
        ws = self.upload(MEMBER, [D1], artifact_type="pcap")
        personal = self.upload(MEMBER, None, artifact_type="pcap")
        batch_of = lambda aid: self.table.items[(f"ARTIFACT#{aid}", "METADATA")]["uploadBatchId"]
        listing = self.lam("artifacts-list")

        def batches(user, query=None):
            resp = listing.handler(wa.event(user, "/artifacts/batches", query=query), None)
            return resp["statusCode"], [b["uploadBatchId"] for b in wa.response_body(resp).get("batches", [])]

        self.assertEqual(batches(USER, {"workspaceId": W1}), (200, [batch_of(ws)]))
        self.assertEqual(batches(MEMBER), (200, [batch_of(personal)]))
        self.assertEqual(batches(OUTSIDER, {"workspaceId": W1})[0], 404)
        self.assertEqual(batches(USER, {"workspaceId": "bad"})[0], 400)


# --- 7, 8. Cancellation ----------------------------------------------------------------


class CancelTests(RunsTestCase):
    def test_creator_can_cancel(self):
        rid = self.started_member_run()
        self.assertTrue(self.detail(MEMBER, rid)[1]["canCancel"])
        self.assertEqual(self.cancel(MEMBER, rid), (200, {"runId": rid, "status": "cancelling"}))
        self.assertTrue(self.run_meta(rid)["cancelRequested"])
        self.lam("runs-api").batch.terminate_job.assert_called_once()

    def test_workspace_owner_can_cancel(self):
        rid = self.started_member_run()
        self.assertTrue(self.detail(USER, rid)[1]["canCancel"])
        self.assertEqual(self.cancel(USER, rid)[0], 200)

    def test_other_members_cannot_cancel(self):
        rid = self.started_member_run()
        status, body = self.detail(MEMBER2, rid)
        self.assertEqual(status, 200)
        self.assertFalse(body["canCancel"])
        status, body = self.cancel(MEMBER2, rid)
        self.assertEqual(status, 403)
        self.assertNotIn("cancelRequested", self.run_meta(rid))
        self.lam("runs-api").batch.terminate_job.assert_not_called()

    def test_owner_run_cannot_be_cancelled_by_a_member(self):
        self.upload(USER, [D1], artifact_type="pcap")
        rid = self.start(USER, {"deviceId": D1}, workspace_id=W1)["runId"]
        self.assertEqual(self.cancel(MEMBER, rid)[0], 403)
        self.assertEqual(self.cancel(USER, rid)[0], 200)


# --- 9. Switching between Personal and a workspace --------------------------------------


class ScopeSwitchTests(RunsTestCase):
    def test_same_user_runs_in_both_scopes_independently(self):
        self.upload(USER, [DP], artifact_type="pcap")
        self.upload(USER, [D1], artifact_type="pcap")
        personal = self.start(USER, {"type": "pcap"})
        workspace = self.start(USER, {"type": "pcap"}, workspace_id=W1)
        self.assertNotIn("workspaceId", personal)
        self.assertEqual(workspace["workspaceId"], W1)
        self.assertEqual([r["runId"] for r in self.list_runs(USER)[1]["runs"]], [personal["runId"]])
        self.assertEqual([r["runId"] for r in self.list_runs(USER, W1)[1]["runs"]], [workspace["runId"]])
        # Each run's detail names its scope, so the web app can tell a run of
        # another scope apart after switching.
        self.assertNotIn("workspaceId", self.detail(USER, personal["runId"])[1]["run"])
        self.assertEqual(self.detail(USER, workspace["runId"])[1]["run"]["workspaceId"], W1)

    def test_selection_from_previous_scope_is_refused(self):
        personal = self.upload(USER, [DP], artifact_type="pcap")
        status, body = self.runs(USER, "POST", "/runs", self.run_body({"artifactIds": [personal]}, workspace_id=W1))
        self.assertEqual(status, 400)
        self.assertFalse([k for k in self.table.items if k[0].startswith("RUN#")])


# --- 10. Scripts stay private ------------------------------------------------------------


class PrivateScriptTests(RunsTestCase):
    def test_members_cannot_run_each_others_scripts(self):
        self.upload(USER, [D1], artifact_type="pcap")
        status, body = self.runs(MEMBER2, "POST", "/runs", self.run_body({"deviceId": D1}, MOD_MEMBER, W1))
        self.assertEqual((status, body), (404, {"error": "Script not found"}))
        self.assertEqual(self.runs(USER, "POST", "/runs/estimate",
                                   self.run_body({"deviceId": D1}, MOD_MEMBER, W1))[0], 404)

    def test_run_detail_does_not_expose_the_script(self):
        rid = self.started_member_run()
        status, body = self.detail(MEMBER2, rid)
        self.assertEqual(status, 200)
        text = json.dumps(body)
        for secret in ("imageUri", "jobDefinitionArn", "sourceKey", f"repo@sha256:{MOD_MEMBER}", "tokenHash"):
            self.assertNotIn(secret, text)
        self.assertEqual(body["run"]["moduleName"], "MEMBER's analyser")

    def test_workspace_run_grants_no_access_to_the_script(self):
        self.started_member_run()
        builds = self.lam("builds-api")
        for user in (USER, MEMBER2):
            for resource, path in (("/modules/{moduleId}", {"moduleId": MOD_MEMBER}),
                                   ("/modules/{moduleId}/versions/{version}/download",
                                    {"moduleId": MOD_MEMBER, "version": "1"})):
                resp = builds.handler(run_event(user, "GET", resource, path=path), None)
                self.assertEqual(resp["statusCode"], 404, (user, resource))
            listed = json.loads(builds.handler(run_event(user, "GET", "/modules"), None)["body"])["modules"]
            self.assertNotIn(MOD_MEMBER, [m["moduleId"] for m in listed])
        self.assertNotIn((f"USER#{USER}", f"MODULE#{MOD_MEMBER}"), self.table.items)


if __name__ == "__main__":
    unittest.main()
