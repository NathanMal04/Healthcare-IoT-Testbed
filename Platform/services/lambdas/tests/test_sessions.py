"""Notebook sessions: sessions-api, sessions-events, the manifest service's
session routes and usage-meter's session metering, with DynamoDB and S3 from
moto and ECS, ELB and Lambda replaced by mocks.

Needs moto (pip install "moto[dynamodb,s3]"); skipped without it.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import hashlib
import importlib.util
import json
import os
import sys
import unittest
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from unittest import mock

try:
    import boto3
    from moto import mock_aws
except ImportError:  # pragma: no cover
    mock_aws = None

LAMBDAS = Path(__file__).resolve().parent.parent
TABLE = "sessions-test-metadata"
BUCKET = "sessions-test-lake"
USER = "user-1"
OTHER = "user-2"
PRICING = {"fargate": {"vcpuHour": 0.04, "gbHour": 0.004}, "fargateSpot": {"vcpuHour": 0.012, "gbHour": 0.0013},
           "ec2": {"vcpuHour": 0.05, "gbHour": 0.005}, "codebuildMinute": 0.01, "minBillSeconds": 60}
ART = "01900000-0000-7000-8000-000000000001"
ART_OTHER = "01900000-0000-7000-8000-000000000002"
ART_PENDING = "01900000-0000-7000-8000-000000000003"
ENV = {
    "AWS_DEFAULT_REGION": "us-east-2", "AWS_REGION": "us-east-2",
    "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
    "METADATA_TABLE_NAME": TABLE, "DATA_LAKE_BUCKET": BUCKET,
    "CLUSTER_ARN": "arn:aws:ecs:us-east-2:1:cluster/sessions", "LISTENER_ARN": "arn:listener",
    "VPC_ID": "vpc-1", "SUBNET_IDS": json.dumps(["subnet-1"]), "SECURITY_GROUP_ID": "sg-session",
    "EXECUTION_ROLE_ARN": "arn:aws:iam::1:role/exec", "LOG_GROUP": "sessions", "TASKDEF_PREFIX": "tb",
    "MANIFEST_URL": "https://manifest/v1", "PRICING": json.dumps(PRICING), "DEFAULT_MONTHLY_LIMIT": "25",
    "NETWORK_CONTROLLER_FUNCTION": "controller",
}


@contextmanager
def _env(values):
    old = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _load(name, folder):
    spec = importlib.util.spec_from_file_location(name, LAMBDAS / folder / "lambda_function.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def api_event(user, method, resource, body=None, session_id=None):
    return {"requestContext": {"authorizer": {"claims": {"sub": user}}}, "httpMethod": method, "resource": resource,
            "pathParameters": {"sessionId": session_id} if session_id else None,
            "body": json.dumps(body) if body is not None else None}


@unittest.skipIf(mock_aws is None, "moto is not installed")
class SessionsTest(unittest.TestCase):
    def setUp(self):
        self.env = _env(ENV)
        self.env.__enter__()
        self.mock = mock_aws()
        self.mock.start()
        sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))
        ddb = boto3.resource("dynamodb", region_name="us-east-2")
        ddb.create_table(TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                         KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                         AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                               {"AttributeName": "sk", "AttributeType": "S"}])
        self.s3 = boto3.client("s3", region_name="us-east-2")
        self.s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-east-2"})
        self.table = ddb.Table(TABLE)
        self.api = _load("sessions_api_under_test", "sessions-api")
        self.events = _load("sessions_events_under_test", "sessions-events")
        self.manifest = _load("runs_manifest_under_test", "runs-manifest")
        self.meter = _load("usage_meter_under_test", "usage-meter")

        self.ecs = mock.MagicMock()
        self.ecs.register_task_definition.return_value = {"taskDefinition": {"taskDefinitionArn": "arn:taskdef:1"}}
        self.ecs.run_task.return_value = {"tasks": [{"taskArn": "arn:aws:ecs:us-east-2:1:task/sessions/abc123"}], "failures": []}
        self.elb = mock.MagicMock()
        self.elb.create_target_group.return_value = {"TargetGroups": [{"TargetGroupArn": "arn:tg"}]}
        self.elb.create_rule.return_value = {"Rules": [{"RuleArn": "arn:rule"}]}
        self.lam = mock.MagicMock()
        for module in (self.api, self.events):
            module.ecs, module.elbv2 = self.ecs, self.elb
        self.api.lambda_client = self.lam

        put = self.table.put_item
        put(Item={"pk": "ENV#platform-base", "sk": "METADATA", "envId": "platform-base", "name": "Analysis base"})
        put(Item={"pk": "ENV#platform-base", "sk": "VERSION#0001", "version": 1, "status": "ready",
                  "imageUri": "repo@sha256:env"})
        put(Item={"pk": "PLATFORM", "sk": "NOTEBOOK", "imageUri": "repo@sha256:nb"})
        for aid, owner, status in ((ART, USER, "ready"), (ART_OTHER, OTHER, "ready"), (ART_PENDING, USER, "pending")):
            put(Item={"pk": f"ARTIFACT#{aid}", "sk": "METADATA", "artifactId": aid, "name": f"{aid[-1]}.log",
                      "type": "log", "status": status, "createdBy": owner, "sizeBytes": 10, "sha256": "ab" * 32,
                      "s3Bucket": BUCKET, "s3Key": f"artifacts/{aid}/x"})

    def tearDown(self):
        self.mock.stop()
        self.env.__exit__(None, None, None)
        sys.path.remove(str(LAMBDAS / "_shared" / "python"))

    # --- helpers ---

    def start(self, user=USER, **body):
        body = {"envId": "platform-base", "artifactIds": [ART], "size": "S", "maxHours": 1, **body}
        return self.api.handler(api_event(user, "POST", "/sessions", body), None)

    def session(self, session_id):
        return self.table.get_item(Key={"pk": f"SESSION#{session_id}", "sk": "METADATA"}).get("Item")

    def budget(self, user=USER):
        return self.table.get_item(Key={"pk": f"USER#{user}", "sk": "BUDGET"}).get("Item")

    def network(self, status):
        self.table.put_item(Item={"pk": "NETWORK", "sk": "STATE", "status": status})

    def started(self, network="up"):
        self.network(network)
        response = self.start()
        self.assertEqual(response["statusCode"], 201, response["body"])
        return json.loads(response["body"])["session"]["sessionId"]

    def ecs_event(self, session_id, last, **detail):
        return {"source": "aws.ecs", "detail": {"startedBy": session_id, "lastStatus": last,
                                                "taskArn": "arn:aws:ecs:us-east-2:1:task/sessions/abc123", **detail}}

    # --- sessions-api ---

    def test_start_while_network_is_down_waits_and_wakes_the_controller(self):
        session_id = self.started(network="down")
        item = self.session(session_id)
        self.assertEqual(item["status"], "waiting")
        self.assertIn("launchSecret", item)
        self.ecs.run_task.assert_not_called()
        self.lam.invoke.assert_called_once()
        self.assertEqual(self.lam.invoke.call_args.kwargs["FunctionName"], "controller")
        # Hold: (1 h + 10 min) x (1 vCPU x 0.04 + 2 GB x 0.004)
        self.assertEqual(self.budget()["held"], Decimal("0.056000"))
        self.assertIsNotNone(self.table.get_item(Key={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{session_id}"}).get("Item"))

    def test_start_while_network_is_up_launches(self):
        session_id = self.started()
        item = self.session(session_id)
        self.assertEqual(item["status"], "launching")
        self.assertNotIn("launchSecret", item)
        self.assertEqual(item["taskArn"], "arn:aws:ecs:us-east-2:1:task/sessions/abc123")
        self.assertEqual(item["targetGroupArn"], "arn:tg")
        run = self.ecs.run_task.call_args.kwargs
        self.assertEqual(run["startedBy"], session_id)
        self.assertEqual(run["overrides"]["cpu"], "1024")
        env = {e["name"]: e["value"] for e in run["overrides"]["containerOverrides"][0]["environment"]}
        self.assertEqual(hashlib.sha256(env["SESSION_TOKEN"].encode()).hexdigest(), item["tokenHash"])
        self.assertEqual(env["JUPYTER_TOKEN"], item["jupyterToken"])
        rule = self.elb.create_rule.call_args.kwargs
        self.assertEqual(rule["Conditions"][0]["PathPatternConfig"]["Values"], [f"/s/{session_id}/*"])
        # The task definition is cached on the environment version and reused.
        self.started()
        self.ecs.register_task_definition.assert_called_once()

    def test_launch_is_idempotent(self):
        session_id = self.started(network="down")
        self.assertEqual(self.api.handler({"action": "launch", "sessionId": session_id}, None), {"launched": True})
        self.assertEqual(self.api.handler({"action": "launch", "sessionId": session_id}, None), {"launched": False})
        self.ecs.run_task.assert_called_once()

    def test_failed_launch_fails_the_session_and_releases_the_hold(self):
        self.ecs.run_task.return_value = {"tasks": [], "failures": [{"reason": "Capacity"}]}
        session_id = self.started()
        item = self.session(session_id)
        self.assertEqual(item["status"], "failed")
        self.assertEqual(self.budget()["held"], 0)
        self.elb.delete_rule.assert_called_once_with(RuleArn="arn:rule")
        self.elb.delete_target_group.assert_called_once_with(TargetGroupArn="arn:tg")

    def test_files_must_be_the_callers_and_ready(self):
        for ids in ([ART_OTHER], [ART_PENDING]):
            response = self.start(artifactIds=ids)
            self.assertEqual(response["statusCode"], 400, ids)
        self.assertIsNone(self.budget())  # nothing held

    def test_refused_without_the_notebook_image(self):
        self.table.delete_item(Key={"pk": "PLATFORM", "sk": "NOTEBOOK"})
        self.assertEqual(self.start()["statusCode"], 409)

    def test_refused_over_budget(self):
        self.assertEqual(self.start(size="L", maxHours=8)["statusCode"], 201)
        self.table.update_item(Key={"pk": f"USER#{USER}", "sk": "BUDGET"}, UpdateExpression="SET monthlyLimit = :l",
                               ExpressionAttributeValues={":l": Decimal("2")})
        self.assertEqual(self.start(size="L", maxHours=8)["statusCode"], 409)

    def test_only_the_owner_sees_a_session(self):
        session_id = self.started()
        other = self.api.handler(api_event(OTHER, "GET", "/sessions/{sessionId}", session_id=session_id), None)
        self.assertEqual(other["statusCode"], 404)
        listed = json.loads(self.api.handler(api_event(OTHER, "GET", "/sessions"), None)["body"])
        self.assertEqual(listed["sessions"], [])

    def test_url_only_once_running_and_healthy(self):
        session_id = self.started()
        get = lambda: json.loads(self.api.handler(  # noqa: E731
            api_event(USER, "GET", "/sessions/{sessionId}", session_id=session_id), None)["body"])
        self.assertNotIn("url", get())
        self.events.handler(self.ecs_event(session_id, "RUNNING", startedAt="2026-10-26T12:00:00Z"), None)
        self.elb.describe_target_health.return_value = {"TargetHealthDescriptions": [{"TargetHealth": {"State": "initial"}}]}
        self.assertNotIn("url", get())
        self.elb.describe_target_health.return_value = {"TargetHealthDescriptions": [{"TargetHealth": {"State": "healthy"}}]}
        detail = get()
        self.assertEqual(detail["url"], f"/s/{session_id}/lab?token={self.session(session_id)['jupyterToken']}")
        self.assertNotIn("jupyterToken", detail["session"])
        self.assertNotIn("tokenHash", detail["session"])

    def test_stop_while_waiting_ends_it_and_releases_the_hold(self):
        session_id = self.started(network="down")
        response = self.api.handler(api_event(USER, "POST", "/sessions/{sessionId}/stop", session_id=session_id), None)
        self.assertEqual(json.loads(response["body"])["status"], "stopped")
        self.assertEqual(self.session(session_id)["status"], "stopped")
        self.assertEqual(self.budget()["held"], 0)

    def test_stop_while_running_stops_the_task(self):
        session_id = self.started()
        self.api.handler(api_event(USER, "POST", "/sessions/{sessionId}/stop", session_id=session_id), None)
        self.ecs.stop_task.assert_called_once()
        self.assertEqual(self.session(session_id)["status"], "stopping")

    # --- sessions-events ---

    def test_events_register_the_ip_then_settle_on_stop(self):
        session_id = self.started()
        attachments = [{"details": [{"name": "privateIPv4Address", "value": "10.20.0.9"}]}]
        self.events.handler(self.ecs_event(session_id, "PENDING", attachments=attachments), None)
        self.elb.register_targets.assert_called_once_with(TargetGroupArn="arn:tg", Targets=[{"Id": "10.20.0.9", "Port": 8888}])
        self.events.handler(self.ecs_event(session_id, "RUNNING", attachments=attachments,
                                           startedAt="2026-10-26T12:00:00Z"), None)
        self.assertEqual(self.session(session_id)["status"], "running")
        self.elb.register_targets.assert_called_once()

        stopped = self.ecs_event(session_id, "STOPPED", startedAt="2026-10-26T12:00:00Z",
                                 stoppedAt="2026-10-26T12:30:00Z", containers=[{"name": "workbench", "exitCode": 0}])
        self.events.handler(stopped, None)
        item = self.session(session_id)
        self.assertEqual(item["status"], "stopped")
        self.assertEqual(item["held"], 0)
        self.assertEqual(self.budget()["held"], 0)
        self.assertIsNone(self.table.get_item(Key={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{session_id}"}).get("Item"))
        self.elb.delete_rule.assert_called_once_with(RuleArn="arn:rule")
        # A repeated event changes nothing.
        self.events.handler(stopped, None)
        self.elb.delete_rule.assert_called_once()

    def test_task_that_never_started_fails(self):
        session_id = self.started()
        self.events.handler(self.ecs_event(session_id, "STOPPED", stoppedReason="CannotPullContainerError: x",
                                           containers=[{"name": "workbench"}]), None)
        item = self.session(session_id)
        self.assertEqual(item["status"], "failed")
        self.assertIn("CannotPullContainerError", item["statusReason"])

    # --- manifest service ---

    def manifest_call(self, session_id, token, resource="/session/manifest"):
        event = {"resource": resource, "headers": {"X-Session-Token": token}, "body": json.dumps({"sessionId": session_id})}
        return self.manifest.handler(event, None)

    def token_of(self, session_id):
        return {e["name"]: e["value"] for e in
                self.ecs.run_task.call_args.kwargs["overrides"]["containerOverrides"][0]["environment"]}["SESSION_TOKEN"]

    def test_manifest_gives_inputs_and_saved_notebooks_to_the_right_token_only(self):
        session_id = self.started()
        token = self.token_of(session_id)
        self.assertEqual(self.manifest_call(session_id, "wrong")["statusCode"], 403)

        body = json.loads(self.manifest_call(session_id, token)["body"])
        self.assertEqual([i["artifactId"] for i in body["inputs"]], [ART])
        self.assertIn("url", body["inputs"][0])
        self.assertIsNone(body["home"])

        upload = json.loads(self.manifest_call(session_id, token, "/session/home")["body"])["upload"]
        self.assertEqual(upload["fields"]["key"], f"sessions/home/{USER}/notebooks.tar.gz")
        self.s3.put_object(Bucket=BUCKET, Key=upload["fields"]["key"], Body=b"x")
        self.assertIsNotNone(json.loads(self.manifest_call(session_id, token)["body"])["home"])

        self.table.update_item(Key={"pk": f"SESSION#{session_id}", "sk": "METADATA"}, UpdateExpression="SET #s = :s",
                               ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": "stopped"})
        self.assertEqual(self.manifest_call(session_id, token)["statusCode"], 409)

    # --- usage-meter ---

    def test_meter_records_a_stopped_session(self):
        session_id = self.started()
        event = self.ecs_event(session_id, "STOPPED", pullStartedAt="2026-10-26T12:00:00Z",
                               startedAt="2026-10-26T12:00:30Z", stoppedAt="2026-10-26T13:00:00Z")
        with mock.patch.object(self.meter, "_period", return_value="2026-10"):
            self.table.update_item(Key={"pk": f"USER#{USER}", "sk": "BUDGET"}, UpdateExpression="SET period = :p",
                                   ExpressionAttributeValues={":p": "2026-10"})
            self.meter.handler(event, None)
            self.meter.handler(event, None)  # redelivered: billed once
        rows = self.table.query(KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(f"USER#{USER}")
                                & boto3.dynamodb.conditions.Key("sk").begins_with("USAGE#"))["Items"]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["sk"].startswith(f"USAGE#2026-10#ecs#{session_id}#abc123"))
        # 1 h x (0.04 + 2 x 0.004)
        self.assertEqual(rows[0]["amount"], Decimal("0.048000"))
        self.assertEqual(self.session(session_id)["costProvisional"], Decimal("0.048000"))
        self.assertEqual(self.budget()["spentProvisional"], Decimal("0.048000"))


if __name__ == "__main__":
    unittest.main()
