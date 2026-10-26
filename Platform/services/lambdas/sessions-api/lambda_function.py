"""Notebook sessions: JupyterLab on an environment, over chosen artifacts.

  GET  /sessions                       the caller's sessions, newest first, plus sizes and limits
  POST /sessions                       start one
  GET  /sessions/{sessionId}           one session; once JupyterLab answers, its URL
  POST /sessions/{sessionId}/stop      stop it
  GET  /sessions/{sessionId}/log       the session container's log (last 1000 lines)

A session is an ECS task on Fargate (on demand) in the runs' private subnet:
no internet and no AWS credentials, files only through the manifest service
with a per-session token. The task runs the environment's image with the
notebook layer (containers/notebook) copied in by an init container.

The browser reaches it as vzoniq.com/s/{sessionId}/: CloudFront sends /s/* to
an internal load balancer, where each session has its own target group and
listener rule. JupyterLab requires the session's own token, which only the
owner gets from GET /sessions/{sessionId}. Sessions are always personal:
only their owner can see or open them, even when their files come from a
workspace.

The network is on demand (network-controller): a session waits in `waiting`
until it is up, and the controller then invokes this function with
{"action": "launch", "sessionId": ...}. Statuses:
  waiting -> launching -> running -> stopping -> stopped | failed

Request body for POST /sessions:
  {"envId": "platform-base", "envVersion": 3,     # version optional: newest ready
   "artifactIds": [...],                         # up to 50 files to stage; may be empty
   "workspaceId": "...",                         # optional: the files are this workspace's
   "size": "S" | "M" | "L", "maxHours": 2, "name": "optional"}
"""
import hashlib
import json
import os
import re
import secrets
import time
import uuid
import boto3
import testbed_authz
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

ecs = boto3.client("ecs")
elbv2 = boto3.client("elbv2")
logs = boto3.client("logs")
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
CLUSTER_ARN = os.environ["CLUSTER_ARN"]
LISTENER_ARN = os.environ["LISTENER_ARN"]
VPC_ID = os.environ["VPC_ID"]
SUBNET_IDS = json.loads(os.environ["SUBNET_IDS"])
SECURITY_GROUP_ID = os.environ["SECURITY_GROUP_ID"]
EXECUTION_ROLE_ARN = os.environ["EXECUTION_ROLE_ARN"]
LOG_GROUP = os.environ["LOG_GROUP"]
TASKDEF_PREFIX = os.environ["TASKDEF_PREFIX"]
MANIFEST_URL = os.environ["MANIFEST_URL"]
PRICING = json.loads(os.environ["PRICING"])
DEFAULT_MONTHLY_LIMIT = Decimal(os.environ.get("DEFAULT_MONTHLY_LIMIT", "25"))
NETWORK_CONTROLLER_FUNCTION = os.environ.get("NETWORK_CONTROLLER_FUNCTION", "")
MAX_HOURS = int(os.environ.get("MAX_HOURS", "8"))
MAX_ACTIVE = int(os.environ.get("MAX_ACTIVE_SESSIONS", "2"))
IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES", "30"))

PORT = 8888
SIZES = {"S": (1, 2048), "M": (2, 8192), "L": (4, 16384)}
PLATFORM_ENVS = ("platform-base", "platform-ghidra")
ACTIVE = ("waiting", "launching", "running", "stopping")
TERMINAL = ("stopped", "failed")
MAX_FILES = 50
MAX_INPUT_BYTES = 20 * 1024 ** 3
# The watchdog stops a session this long after its time limit at the latest;
# the hold covers it.
STOP_GRACE_SECONDS = 600
EPHEMERAL_STORAGE_GIB = 50

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ENV_ID_PATTERN = re.compile(r"^(platform-[a-z]+|[0-9a-f-]{36})$")
CENT = Decimal("0.000001")


class RequestError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details or {}


def handler(event, context):
    if event.get("action") == "launch":
        # From the network-controller once the network is up.
        return launch(dynamodb.Table(TABLE), event.get("sessionId"))

    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    params = event.get("pathParameters") or {}
    table = dynamodb.Table(TABLE)

    try:
        body = json.loads(event.get("body") or "{}") if method == "POST" else {}
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})
    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    try:
        if (method, resource) == ("GET", "/sessions"):
            return _resp(200, {"sessions": _list(table, user_id), "sizes": _sizes(),
                               "limits": {"maxHours": MAX_HOURS, "maxFiles": MAX_FILES, "maxActive": MAX_ACTIVE,
                                          "idleMinutes": IDLE_MINUTES},
                               "network": _network_status(table)})
        if (method, resource) == ("POST", "/sessions"):
            return _start(table, user_id, body)

        session = _owned(table, user_id, _uuid(params.get("sessionId"), "sessionId"))
        if resource == "/sessions/{sessionId}":
            return _resp(200, _detail(table, session))
        if resource == "/sessions/{sessionId}/stop":
            return _stop(table, session)
        if resource == "/sessions/{sessionId}/log":
            return _log(session)
    except RequestError as e:
        return _resp(e.status, {"error": e.message, **e.details})

    return _resp(404, {"error": "Unknown route"})


# --- Start ------------------------------------------------------------------------------

def _start(table, user_id, body):
    size = body.get("size") or "S"
    if size not in SIZES:
        raise RequestError(400, f"size must be one of: {', '.join(SIZES)}")
    max_hours = body.get("maxHours", 2)
    if not _is_int(max_hours) or not 1 <= max_hours <= MAX_HOURS:
        raise RequestError(400, f"maxHours must be a whole number from 1 to {MAX_HOURS}")
    name = body.get("name") or ""
    if not isinstance(name, str) or len(name) > 120:
        raise RequestError(400, "name must be at most 120 characters")

    env_id = body.get("envId") or "platform-base"
    if not isinstance(env_id, str) or not ENV_ID_PATTERN.match(env_id):
        raise RequestError(400, "envId is invalid")
    env, version = _env_version(table, user_id, env_id, body.get("envVersion"))
    notebook_image = (table.get_item(Key={"pk": "PLATFORM", "sk": "NOTEBOOK"}).get("Item") or {}).get("imageUri")
    if not notebook_image:
        raise RequestError(409, "Notebooks aren't available yet: the notebook image hasn't been published")

    workspace_id = _workspace_scope(table, user_id, body["workspaceId"]) if body.get("workspaceId") else None
    artifacts = _inputs(table, user_id, body.get("artifactIds") or [], workspace_id)

    if sum(1 for s in _list(table, user_id) if s["status"] in ACTIVE) >= MAX_ACTIVE:
        raise RequestError(409, f"You can have at most {MAX_ACTIVE} notebook sessions open; stop one first")

    vcpu, memory = SIZES[size]
    max_seconds = max_hours * 3600
    held = _money(Decimal(max_seconds + STOP_GRACE_SECONDS) / 3600 * _hourly_rate(vcpu, memory))
    _hold(table, user_id, held)

    session_id = _uuid7()
    token = secrets.token_urlsafe(32)
    now = _now()
    item = {
        "pk": f"SESSION#{session_id}", "sk": "METADATA", "entity": "session", "sessionId": session_id,
        "name": name.strip() or f"{env['name']} v{int(version['version'])}",
        "envId": env_id, "envName": env["name"], "envVersion": int(version["version"]),
        "imageUri": version["imageUri"], "notebookImage": notebook_image,
        "size": size, "vcpu": vcpu, "memoryMiB": memory, "maxSeconds": max_seconds,
        "maxCost": held, "held": held, "costProvisional": Decimal(0),
        "artifactIds": [a["artifactId"] for a in artifacts], "inputCount": len(artifacts),
        "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
        # The session token itself is kept only until launch hands it to the
        # task (launch removes it).
        "launchSecret": token,
        # Not a secret from the owner: they get it to open JupyterLab.
        "jupyterToken": secrets.token_urlsafe(32),
        "status": "waiting", "statusUpdatedAt": now, "createdBy": user_id, "createdAt": now, "updatedAt": now,
    }
    if workspace_id:
        # Deliberately not "workspaceId": that would make the session a
        # workspace resource (testbed_authz), visible to other members.
        item["inputsWorkspaceId"] = workspace_id
    try:
        table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
        with table.batch_writer() as writer:
            writer.put_item(Item={"pk": f"USER#{user_id}", "sk": f"SESSION#{session_id}", "entity": "user-session",
                                  "role": "owner", "name": item["name"], "createdAt": now})
            writer.put_item(Item={"pk": f"SESSION#{session_id}", "sk": f"USER#{user_id}", "entity": "session-user",
                                  "role": "owner"})
            writer.put_item(Item={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{session_id}", "entity": "active-session",
                                  "userId": user_id, "createdAt": now})
    except Exception:
        _release(table, user_id, held)
        raise

    if _network_status(table) == "up":
        launch(table, session_id)
    else:
        _wake_network()
    item = table.get_item(Key={"pk": f"SESSION#{session_id}", "sk": "METADATA"}).get("Item")
    return _resp(201, {"session": _public(item)})


def _env_version(table, user_id, env_id, requested):
    """A ready environment version the caller may open: a platform one, or
    their own (the same rule as building scripts on it)."""
    if env_id not in PLATFORM_ENVS:
        link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"ENV#{env_id}"}).get("Item")
        if link is None or link.get("role") != "owner":
            raise RequestError(404, "Environment not found")
    env = table.get_item(Key={"pk": f"ENV#{env_id}", "sk": "METADATA"}).get("Item")
    if env is None:
        raise RequestError(404, "Environment not found")
    if requested is not None:
        if not _is_int(requested) or requested < 1:
            raise RequestError(400, "envVersion must be a positive integer")
        version = table.get_item(Key={"pk": f"ENV#{env_id}", "sk": f"VERSION#{requested:04d}"}).get("Item")
        if version is None or version.get("status") != "ready" or not version.get("imageUri"):
            raise RequestError(409, f"Environment version {requested} is not ready")
        return env, version
    rows = table.query(KeyConditionExpression=Key("pk").eq(f"ENV#{env_id}") & Key("sk").begins_with("VERSION#"),
                       ScanIndexForward=False).get("Items", [])
    for row in rows:
        if row.get("status") == "ready" and row.get("imageUri"):
            return env, row
    raise RequestError(409, "This environment has no ready version yet")


def _inputs(table, user_id, raw, workspace_id):
    """The chosen artifacts, all ready and of the session's file scope: the
    caller's own personal files, or (with workspaceId) that workspace's."""
    if not isinstance(raw, list) or len(raw) > MAX_FILES:
        raise RequestError(400, f"artifactIds must be a list of at most {MAX_FILES} ids")
    ids = list(dict.fromkeys(_uuid(a, "artifactIds") for a in raw))
    items = {i["artifactId"]: i for i in _batch_get([{"pk": f"ARTIFACT#{a}", "sk": "METADATA"} for a in ids])}
    chosen = []
    for aid in ids:
        item = items.get(aid)
        in_scope = item is not None and (
            item.get("workspaceId") == workspace_id if workspace_id
            else item.get("createdBy") == user_id and "workspaceId" not in item)
        if not in_scope:
            # Which ones isn't said, so ids aren't confirmed.
            raise RequestError(400, "Some of the selected files aren't yours or aren't in this workspace")
        if item.get("status") != "ready":
            raise RequestError(400, f"{item.get('name') or aid} isn't ready yet")
        chosen.append(item)
    if sum(int(a.get("sizeBytes", 0)) for a in chosen) > MAX_INPUT_BYTES:
        raise RequestError(400, "The selected files are over 20 GiB together")
    return chosen


def _workspace_scope(table, user_id, raw):
    workspace_id = _uuid(raw, "workspaceId")
    try:
        testbed_authz.require_member(table, user_id, workspace_id)
    except testbed_authz.AuthorizationError:
        raise RequestError(404, "Workspace not found")
    return workspace_id


# --- Launch (when the network is up) -------------------------------------------------

def launch(table, session_id):
    """Starts a waiting session's task. Idempotent: only the call that moves
    it from waiting to launching does anything."""
    if not isinstance(session_id, str) or not UUID_PATTERN.match(session_id):
        return {"launched": False}
    key = {"pk": f"SESSION#{session_id}", "sk": "METADATA"}
    try:
        session = table.update_item(
            Key=key,
            UpdateExpression="SET #st = :l, statusUpdatedAt = :now REMOVE launchSecret",
            ConditionExpression="#st = :w",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":l": "launching", ":w": "waiting", ":now": _now()},
            ReturnValues="ALL_OLD",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"launched": False}
        raise

    target_group = rule = None
    try:
        task_definition = _task_definition(table, session)
        target_group, rule = _route(session_id)
        table.update_item(Key=key, UpdateExpression="SET targetGroupArn = :tg, ruleArn = :r",
                          ExpressionAttributeValues={":tg": target_group, ":r": rule})
        task_arn = _run_task(session, task_definition)
    except Exception as e:
        print(json.dumps({"event": "session_launch_failed", "sessionId": session_id, "error": str(e)}))
        _cleanup_route(target_group, rule)
        _fail(table, session, "The session could not be started; try again in a few minutes")
        return {"launched": False}

    table.update_item(Key=key, UpdateExpression="SET taskArn = :t, launchedAt = :now",
                      ExpressionAttributeValues={":t": task_arn, ":now": _now()})
    return {"launched": True}


def _task_definition(table, session):
    """One task definition per environment version (and notebook image),
    registered the first time a session opens it."""
    version_key = {"pk": f"ENV#{session['envId']}", "sk": f"VERSION#{int(session['envVersion']):04d}"}
    version = table.get_item(Key=version_key).get("Item") or {}
    cached = version.get("sessionTaskDef") or {}
    if (cached.get("arn") and cached.get("notebookImage") == session["notebookImage"]
            and cached.get("imageUri") == session["imageUri"]):
        return cached["arn"]

    def log_config(prefix):
        return {"logDriver": "awslogs", "options": {
            "awslogs-group": LOG_GROUP, "awslogs-region": os.environ.get("AWS_REGION", "us-east-2"),
            "awslogs-stream-prefix": prefix}}

    family = f"{TASKDEF_PREFIX}-nb-{session['envId']}-{int(session['envVersion'])}"
    # No taskRoleArn: sessions get no AWS credentials.
    arn = ecs.register_task_definition(
        family=family,
        networkMode="awsvpc",
        requiresCompatibilities=["FARGATE"],
        runtimePlatform={"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
        cpu="1024", memory="2048",  # overridden per session from its size
        executionRoleArn=EXECUTION_ROLE_ARN,
        ephemeralStorage={"sizeInGiB": EPHEMERAL_STORAGE_GIB},
        volumes=[{"name": "notebook"}],
        containerDefinitions=[
            {
                # Copies JupyterLab (/opt/notebook) into the shared volume.
                "name": "notebook-layer",
                "image": session["notebookImage"],
                "essential": False,
                "entryPoint": ["/bin/sh", "-c"],
                "command": ["cp -a /opt/notebook/. /mnt/notebook/"],
                "mountPoints": [{"sourceVolume": "notebook", "containerPath": "/mnt/notebook"}],
                "logConfiguration": log_config("layer"),
            },
            {
                "name": "workbench",
                "image": session["imageUri"],
                "essential": True,
                "entryPoint": ["/opt/notebook/bin/python", "/opt/notebook/session.py"],
                "dependsOn": [{"containerName": "notebook-layer", "condition": "SUCCESS"}],
                "mountPoints": [{"sourceVolume": "notebook", "containerPath": "/opt/notebook", "readOnly": True}],
                "portMappings": [{"containerPort": PORT, "protocol": "tcp"}],
                "environment": [
                    # No internet: fail at once instead of retrying for minutes.
                    {"name": "PIP_NO_INDEX", "value": "1"},
                    {"name": "PIP_DISABLE_PIP_VERSION_CHECK", "value": "1"},
                ],
                "linuxParameters": {"initProcessEnabled": True},
                # Time to save the notebooks folder after SIGTERM.
                "stopTimeout": 120,
                "logConfiguration": log_config("session"),
            },
        ],
    )["taskDefinition"]["taskDefinitionArn"]
    table.update_item(Key=version_key, UpdateExpression="SET sessionTaskDef = :d",
                      ExpressionAttributeValues={":d": {"arn": arn, "notebookImage": session["notebookImage"],
                                                        "imageUri": session["imageUri"]}})
    return arn


def _target_group_name(session_id):
    return "nb-" + session_id.replace("-", "")[-28:]


def _route(session_id):
    """The session's target group, and the listener rule that sends
    /s/{sessionId}/* to it."""
    target_group = elbv2.create_target_group(
        Name=_target_group_name(session_id), Protocol="HTTP", Port=PORT, VpcId=VPC_ID, TargetType="ip",
        HealthCheckProtocol="HTTP", HealthCheckPath=f"/s/{session_id}/api", HealthCheckIntervalSeconds=10,
        HealthCheckTimeoutSeconds=5, HealthyThresholdCount=2, UnhealthyThresholdCount=5,
        Matcher={"HttpCode": "200"},
    )["TargetGroups"][0]["TargetGroupArn"]
    for _ in range(8):
        try:
            rule = elbv2.create_rule(
                ListenerArn=LISTENER_ARN, Priority=1 + secrets.randbelow(49999),
                Conditions=[{"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/s/{session_id}/*"]}}],
                Actions=[{"Type": "forward", "TargetGroupArn": target_group}],
            )["Rules"][0]["RuleArn"]
            return target_group, rule
        except ClientError as e:
            if e.response["Error"]["Code"] != "PriorityInUse":
                _cleanup_route(target_group, None)
                raise
    _cleanup_route(target_group, None)
    raise RuntimeError("No free listener rule priority")


def _cleanup_route(target_group, rule):
    try:
        if rule:
            elbv2.delete_rule(RuleArn=rule)
        if target_group:
            elbv2.delete_target_group(TargetGroupArn=target_group)
    except ClientError as e:
        print(json.dumps({"event": "session_route_cleanup_failed", "error": str(e)}))


def _run_task(session, task_definition):
    session_id = session["sessionId"]
    response = ecs.run_task(
        cluster=CLUSTER_ARN,
        taskDefinition=task_definition,
        launchType="FARGATE",
        platformVersion="LATEST",
        count=1,
        startedBy=session_id,
        networkConfiguration={"awsvpcConfiguration": {
            "subnets": SUBNET_IDS, "securityGroups": [SECURITY_GROUP_ID], "assignPublicIp": "DISABLED"}},
        overrides={
            "cpu": str(int(session["vcpu"]) * 1024),
            "memory": str(int(session["memoryMiB"])),
            "containerOverrides": [{"name": "workbench", "environment": [
                {"name": "SESSION_ID", "value": session_id},
                {"name": "SESSION_TOKEN", "value": session["launchSecret"]},
                {"name": "MANIFEST_URL", "value": MANIFEST_URL},
                {"name": "JUPYTER_TOKEN", "value": session["jupyterToken"]},
                {"name": "MAX_SECONDS", "value": str(int(session["maxSeconds"]))},
                {"name": "IDLE_SECONDS", "value": str(IDLE_MINUTES * 60)},
            ]}],
        },
        tags=[{"key": "userId", "value": session["createdBy"]}, {"key": "sessionId", "value": session_id}],
    )
    if response.get("failures") or not response.get("tasks"):
        reasons = "; ".join(f"{f.get('reason')} {f.get('detail') or ''}".strip() for f in response.get("failures", []))
        raise RuntimeError(f"RunTask failed: {reasons or 'no task'}")
    return response["tasks"][0]["taskArn"]


def _fail(table, session, reason, status="failed"):
    """Ends a session that never ran (failed, or stopped while waiting) and
    releases its hold."""
    key = {"pk": f"SESSION#{session['sessionId']}", "sk": "METADATA"}
    try:
        old = table.update_item(
            Key=key,
            UpdateExpression="SET #st = :new, statusReason = :r, held = :z, statusUpdatedAt = :now, endedAt = :now "
                             "REMOVE launchSecret",
            ConditionExpression="NOT #st IN (:s, :f)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":new": status, ":f": "failed", ":s": "stopped", ":r": reason,
                                       ":z": Decimal(0), ":now": _now()},
            ReturnValues="ALL_OLD",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    if Decimal(old.get("held", 0)) > 0:
        _release(table, session["createdBy"], Decimal(old["held"]))
    table.delete_item(Key={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{session['sessionId']}"})


# --- Reads and stop -----------------------------------------------------------------------

def _list(table, user_id):
    ids = _link_ids(table, f"USER#{user_id}", "SESSION#", limit=50)
    items = _batch_get([{"pk": f"SESSION#{i}", "sk": "METADATA"} for i in ids])
    return [_public(i) for i in sorted(items, key=lambda i: i["sessionId"], reverse=True)]


def _detail(table, session):
    """The session, its URL once JupyterLab answers the load balancer's health
    check, and the cost so far."""
    if session["status"] == "running" and not session.get("ready") and session.get("targetGroupArn"):
        try:
            health = elbv2.describe_target_health(TargetGroupArn=session["targetGroupArn"])
            if any(t["TargetHealth"]["State"] == "healthy" for t in health.get("TargetHealthDescriptions", [])):
                table.update_item(Key={"pk": session["pk"], "sk": "METADATA"}, UpdateExpression="SET ready = :t",
                                  ExpressionAttributeValues={":t": True})
                session["ready"] = True
        except ClientError as e:
            print(json.dumps({"event": "target_health_failed", "error": str(e)}))
    result = {"session": _public(session), "network": _network_status(table)}
    if session["status"] == "running" and session.get("ready"):
        result["url"] = f"/s/{session['sessionId']}/lab?token={session['jupyterToken']}"
        result["token"] = session["jupyterToken"]
    return result


def _stop(table, session):
    if session["status"] in TERMINAL:
        raise RequestError(409, f"The session is already {session['status']}")
    if session["status"] == "waiting":
        # Never launched: nothing to stop.
        _fail(table, session, "Stopped before it started", status="stopped")
        return _resp(200, {"sessionId": session["sessionId"], "status": "stopped"})
    table.update_item(
        Key={"pk": session["pk"], "sk": "METADATA"},
        UpdateExpression="SET #st = :s, stopReason = if_not_exists(stopReason, :r), statusUpdatedAt = :now",
        ConditionExpression="NOT #st IN (:stopped, :failed)",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":s": "stopping", ":r": "Stopped by you", ":now": _now(),
                                   ":stopped": "stopped", ":failed": "failed"},
    )
    if session.get("taskArn"):
        ecs.stop_task(cluster=CLUSTER_ARN, task=session["taskArn"], reason="Stopped by user")
    return _resp(200, {"sessionId": session["sessionId"], "status": "stopping"})


def _log(session):
    if not session.get("taskArn"):
        return _resp(200, {"lines": [], "note": "This session hasn't started yet"})
    stream = f"session/workbench/{session['taskArn'].rsplit('/', 1)[-1]}"
    try:
        events = logs.get_log_events(logGroupName=LOG_GROUP, logStreamName=stream, limit=1000,
                                     startFromHead=False).get("events", [])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return _resp(200, {"lines": []})
        raise
    return _resp(200, {"lines": [e["message"].rstrip("\n") for e in events]})


def _owned(table, user_id, session_id):
    """The session's METADATA if the caller owns it; 404 otherwise, so ids
    aren't revealed. Sessions are never shared."""
    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"SESSION#{session_id}"}).get("Item")
    session = table.get_item(Key={"pk": f"SESSION#{session_id}", "sk": "METADATA"}).get("Item") if link else None
    if session is None or link.get("role") != "owner" or session.get("createdBy") != user_id:
        raise RequestError(404, "Session not found")
    return session


# --- Budget (the same rules as runs-api) -----------------------------------------------

def _period():
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _budget(table, user_id):
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    item = table.get_item(Key=key).get("Item")
    if item is None:
        default = {**key, "entity": "budget", "monthlyLimit": DEFAULT_MONTHLY_LIMIT, "held": Decimal(0),
                   "spentProvisional": Decimal(0), "period": _period(), "heavyEnabled": False,
                   "version": 0, "updatedAt": _now()}
        try:
            table.put_item(Item=default, ConditionExpression="attribute_not_exists(pk)")
            return default
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            item = table.get_item(Key=key).get("Item")
    return item


def _hold(table, user_id, amount):
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    for _ in range(6):
        budget = _budget(table, user_id)
        period = _period()
        spent = budget["spentProvisional"] if budget.get("period") == period else Decimal(0)
        available = budget["monthlyLimit"] - spent - budget["held"]
        if amount > available:
            raise RequestError(409, "This session's maximum cost is more than your remaining budget", {
                "maxCost": float(amount), "available": float(available),
            })
        try:
            table.update_item(
                Key=key,
                UpdateExpression="SET held = :h, spentProvisional = :s, period = :p, updatedAt = :now ADD version :one",
                ConditionExpression="version = :v",
                ExpressionAttributeValues={":h": budget["held"] + amount, ":s": spent, ":p": period,
                                           ":now": _now(), ":one": 1, ":v": budget["version"]},
            )
            return
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise RequestError(503, "Your budget is busy; try again")


def _release(table, user_id, amount):
    table.update_item(
        Key={"pk": f"USER#{user_id}", "sk": "BUDGET"},
        UpdateExpression="ADD held :neg, version :one SET updatedAt = :now",
        ExpressionAttributeValues={":neg": -amount, ":one": 1, ":now": _now()},
    )


def _hourly_rate(vcpu, memory_mib):
    rates = PRICING["fargate"]
    return Decimal(str(rates["vcpuHour"])) * vcpu + Decimal(str(rates["gbHour"])) * Decimal(memory_mib) / 1024


def _sizes():
    return {name: {"vcpu": vcpu, "memoryMiB": memory, "hourly": float(_money(_hourly_rate(vcpu, memory)))}
            for name, (vcpu, memory) in SIZES.items()}


# --- Network --------------------------------------------------------------------------------

def _network_status(table):
    return (table.get_item(Key={"pk": "NETWORK", "sk": "STATE"}).get("Item") or {}).get("status", "down")


def _wake_network():
    if not NETWORK_CONTROLLER_FUNCTION:
        return
    try:
        lambda_client.invoke(FunctionName=NETWORK_CONTROLLER_FUNCTION, InvocationType="Event", Payload=b"{}")
    except ClientError as e:
        print(json.dumps({"event": "network_wake_failed", "error": str(e)}))


# --- Helpers ---------------------------------------------------------------------------

PUBLIC_FIELDS = (
    "sessionId", "name", "envId", "envName", "envVersion", "size", "vcpu", "memoryMiB", "maxSeconds", "maxCost",
    "held", "costProvisional", "inputCount", "artifactIds", "inputsWorkspaceId", "status", "statusReason",
    "stopReason", "statusUpdatedAt", "createdAt", "launchedAt", "startedAt", "endedAt", "ready",
)


def _public(item):
    out = {k: _plain(item[k]) for k in PUBLIC_FIELDS if k in item}
    out["ready"] = bool(item.get("ready"))
    return out


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, set, tuple)):
        return [_plain(v) for v in value]
    return value


def _link_ids(table, pk, prefix, limit=None):
    ids, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
                       "ScanIndexForward": False}
    while True:
        page = table.query(**kwargs)
        ids += [row["sk"][len(prefix):] for row in page.get("Items", [])]
        if "LastEvaluatedKey" not in page or (limit and len(ids) >= limit):
            return ids[:limit] if limit else ids
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _batch_get(keys):
    items = []
    for start in range(0, len(keys), 100):
        request = {TABLE: {"Keys": keys[start:start + 100]}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    return items


def _money(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.match(value):
        raise RequestError(400, f"{name} is invalid")
    return value


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _uuid7():
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body, default=_plain),
    }
