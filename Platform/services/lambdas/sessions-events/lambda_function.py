"""EventBridge target for "ECS Task State Change" events on the sessions
cluster.

- Once the task has its private IP, registers it with the session's target
  group, so the load balancer (and so CloudFront's /s/{sessionId}/*) reaches
  JupyterLab.
- RUNNING: the session is running (or, if it was stopped while launching,
  stops the task now).
- STOPPED: the session's final status and reason, its budget hold released,
  its listener rule and target group deleted, and its ACTIVE#SESSIONS row
  removed. usage-meter records the cost from the same event.

Tasks carry the session id in startedBy. Every write only moves status
forward, so late or repeated events are harmless.
"""
import json
import os
import re
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from botocore.exceptions import ClientError

ecs = boto3.client("ecs")
elbv2 = boto3.client("elbv2")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
CLUSTER_ARN = os.environ["CLUSTER_ARN"]
PORT = 8888
TERMINAL = ("stopped", "failed")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# Exit codes of a container stopped by SIGTERM/SIGKILL: an ordinary stop.
STOP_EXIT_CODES = (0, 137, 143)


def handler(event, context):
    detail = event.get("detail", {})
    session_id = detail.get("startedBy") or ""
    if not UUID_PATTERN.match(session_id):
        return
    table = dynamodb.Table(TABLE)
    key = {"pk": f"SESSION#{session_id}", "sk": "METADATA"}
    session = table.get_item(Key=key).get("Item")
    if session is None or session.get("status") in TERMINAL:
        return
    if session.get("taskArn") and session["taskArn"] != detail.get("taskArn"):
        return  # not this session's current task

    last = detail.get("lastStatus")
    if last == "STOPPED":
        finish(table, session, detail)
        return

    ip = private_ip(detail)
    if ip and not session.get("taskIp") and session.get("targetGroupArn"):
        elbv2.register_targets(TargetGroupArn=session["targetGroupArn"], Targets=[{"Id": ip, "Port": PORT}])
        table.update_item(Key=key, UpdateExpression="SET taskIp = :ip", ExpressionAttributeValues={":ip": ip})

    if last == "RUNNING":
        if session.get("status") == "stopping":
            # Stopped by its owner while it was still launching.
            ecs.stop_task(cluster=CLUSTER_ARN, task=detail["taskArn"], reason="Stopped by user")
            return
        try:
            table.update_item(
                Key=key,
                UpdateExpression="SET #st = :r, startedAt = :t, statusUpdatedAt = :now",
                ConditionExpression="#st = :l",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={":r": "running", ":l": "launching", ":now": _now(),
                                           ":t": detail.get("startedAt") or _now()},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise


def private_ip(detail):
    for attachment in detail.get("attachments") or []:
        for item in attachment.get("details") or []:
            if item.get("name") == "privateIPv4Address" and item.get("value"):
                return item["value"]
    return None


def stop_reason(session, detail):
    """(status, reason) for a stopped task."""
    if session.get("stopReason"):
        return "stopped", session["stopReason"]
    workbench = next((c for c in detail.get("containers") or [] if c.get("name") == "workbench"), {})
    exit_code = workbench.get("exitCode")
    if not detail.get("startedAt"):
        reason = workbench.get("reason") or detail.get("stoppedReason") or "The task didn't start"
        return "failed", f"The session could not start: {reason}"
    if exit_code in STOP_EXIT_CODES:
        return "stopped", "Stopped after being idle, or at its time limit"
    return "failed", f"JupyterLab exited with code {exit_code}; see the session log"


def finish(table, session, detail):
    status, reason = stop_reason(session, detail)
    key = {"pk": session["pk"], "sk": "METADATA"}
    try:
        old = table.update_item(
            Key=key,
            UpdateExpression="SET #st = :s, statusReason = :r, held = :z, endedAt = :end, statusUpdatedAt = :now "
                             "REMOVE launchSecret",
            ConditionExpression="NOT #st IN (:stopped, :failed)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":s": status, ":r": reason, ":z": Decimal(0), ":now": _now(),
                                       ":end": detail.get("stoppedAt") or _now(),
                                       ":stopped": "stopped", ":failed": "failed"},
            ReturnValues="ALL_OLD",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return  # already settled
        raise

    held = Decimal(old.get("held", 0))
    if held > 0:
        table.update_item(
            Key={"pk": f"USER#{old['createdBy']}", "sk": "BUDGET"},
            UpdateExpression="ADD held :neg, version :one SET updatedAt = :now",
            ExpressionAttributeValues={":neg": -held, ":one": 1, ":now": _now()},
        )
    table.delete_item(Key={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{old['sessionId']}"})
    for call, kwargs in ((elbv2.delete_rule, {"RuleArn": old.get("ruleArn")}),
                         (elbv2.delete_target_group, {"TargetGroupArn": old.get("targetGroupArn")})):
        if not next(iter(kwargs.values())):
            continue
        try:
            call(**kwargs)
        except ClientError as e:
            print(json.dumps({"event": "session_route_cleanup_failed", "sessionId": old["sessionId"], "error": str(e)}))
    print(json.dumps({"event": "session_finished", "sessionId": old["sessionId"], "status": status, "reason": reason}))


def _now():
    return datetime.now(timezone.utc).isoformat()
