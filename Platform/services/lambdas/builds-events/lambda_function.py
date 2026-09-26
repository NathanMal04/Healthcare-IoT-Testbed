"""EventBridge target for CodeBuild "Build State Change" events.

Marks the environment or module version the build was for as `ready` (with
its image digest) or `build_failed` (with the reason build.py exported). For
a ready module version it registers the Batch job definition(s) its runs
use: Batch can't change a job's image at submit time, so each version gets
its own.
"""
import json
import os
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

codebuild = boto3.client("codebuild")
batch = boto3.client("batch")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
EXECUTION_ROLE_ARN = os.environ["BATCH_EXECUTION_ROLE_ARN"]
RUN_LOG_GROUP = os.environ["RUN_LOG_GROUP"]
JOBDEF_PREFIX = os.environ["JOBDEF_PREFIX"]
HEAVY_ENABLED = os.environ.get("HEAVY_ENABLED", "false") == "true"
EPHEMERAL_STORAGE_GIB = int(os.environ.get("EPHEMERAL_STORAGE_GIB", "50"))
REGION = os.environ.get("AWS_REGION", "us-east-2")

TERMINAL = {"SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"}

# First match wins. Timeouts and script problems are final; host loss, Spot
# interruption (the launcher exits 143) and launcher infrastructure errors
# (exit 1) are retried up to the job's attempt limit.
RETRY_RULES = [
    {"onStatusReason": "Job attempt duration exceeded timeout", "action": "EXIT"},
    {"onStatusReason": "Host EC2*", "action": "RETRY"},
    {"onReason": "CannotPullContainerError*", "action": "RETRY"},
    {"onExitCode": "143", "action": "RETRY"},
    {"onExitCode": "1", "action": "RETRY"},
]


def handler(event, context):
    detail = event.get("detail", {})
    status = detail.get("build-status")
    build_id = detail.get("build-id")
    if status not in TERMINAL or not build_id:
        return

    builds = codebuild.batch_get_builds(ids=[build_id]).get("builds", [])
    if not builds:
        return
    build = builds[0]
    env = {v["name"]: v.get("value", "") for v in build.get("environment", {}).get("environmentVariables", [])}
    exported = {v["name"]: v.get("value", "") for v in build.get("exportedEnvironmentVariables", [])}
    target = env.get("TARGET", "")
    if "/" not in target:
        print(json.dumps({"event": "build_without_target", "buildId": build_id}))
        return

    pk, sk = target.split("/", 1)
    key = {"pk": pk, "sk": sk}
    table = dynamodb.Table(TABLE)
    item = table.get_item(Key=key).get("Item")
    if item is None or item.get("buildId") != build_id or item.get("status") != "building":
        # Superseded, or a repeat of an event already handled.
        print(json.dumps({"event": "build_event_skipped", "target": target, "buildId": build_id}))
        return

    image_uri = exported.get("IMAGE_URI", "")
    if status != "SUCCEEDED" or not image_uri:
        reason = exported.get("BUILD_ERROR") or f"Build {status.lower().replace('_', ' ')}; see the build log"
        _finish(table, key, build_id, "build_failed", {"statusReason": reason})
        return

    updates = {"imageUri": image_uri}
    if pk.startswith("MODULE#"):
        try:
            updates.update(_register_job_definitions(item, image_uri))
        except ClientError as e:
            _finish(table, key, build_id, "build_failed",
                    {"statusReason": f"Image built, but its job definition could not be registered: {e}"})
            raise
    if _finish(table, key, build_id, "ready", updates):
        _bump_latest_ready(table, pk, int(item["version"]))


def _register_job_definitions(item, image_uri):
    name = f"{JOBDEF_PREFIX}-mod-{item['moduleId']}-{int(item['version'])}"
    base = {
        "image": image_uri,
        "executionRoleArn": EXECUTION_ROLE_ARN,
        # Overridden per run from the chosen size.
        "resourceRequirements": [{"type": "VCPU", "value": "1"}, {"type": "MEMORY", "value": "2048"}],
        "environment": [{"name": "PLATFORM_COMMAND", "value": json.dumps(item["command"])}],
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {"awslogs-group": RUN_LOG_GROUP, "awslogs-region": REGION, "awslogs-stream-prefix": "run"},
        },
    }
    common = {
        "type": "container",
        "retryStrategy": {"attempts": 3, "evaluateOnExit": RETRY_RULES},
        "timeout": {"attemptDurationSeconds": 1800},
        "propagateTags": True,
    }
    # No jobRoleArn anywhere: jobs get no AWS credentials.
    fargate = batch.register_job_definition(
        jobDefinitionName=name,
        platformCapabilities=["FARGATE"],
        containerProperties={
            **base,
            "networkConfiguration": {"assignPublicIp": "DISABLED"},
            "fargatePlatformConfiguration": {"platformVersion": "LATEST"},
            "ephemeralStorage": {"sizeInGiB": EPHEMERAL_STORAGE_GIB},
        },
        **common,
    )["jobDefinitionArn"]
    result = {"jobDefinitionArn": fargate}
    if HEAVY_ENABLED:
        result["heavyJobDefinitionArn"] = batch.register_job_definition(
            jobDefinitionName=f"{name}-heavy",
            platformCapabilities=["EC2"],
            containerProperties=base,
            **common,
        )["jobDefinitionArn"]
    return result


def _finish(table, key, build_id, status, fields):
    """Sets the final status, only if the version is still waiting on this build."""
    assignments = ["#st = :s", "statusUpdatedAt = :now"]
    values = {":s": status, ":now": datetime.now(timezone.utc).isoformat(), ":build": build_id, ":building": "building"}
    for i, (name, value) in enumerate(fields.items()):
        assignments.append(f"{name} = :f{i}")
        values[f":f{i}"] = value
    try:
        table.update_item(
            Key=key,
            UpdateExpression="SET " + ", ".join(assignments),
            ConditionExpression="buildId = :build AND #st = :building",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False  # a repeat of an event already handled
        raise


def _bump_latest_ready(table, pk, version):
    try:
        table.update_item(
            Key={"pk": pk, "sk": "METADATA"},
            UpdateExpression="SET latestReadyVersion = :v",
            ConditionExpression="attribute_not_exists(latestReadyVersion) OR latestReadyVersion < :v",
            ExpressionAttributeValues={":v": version},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
