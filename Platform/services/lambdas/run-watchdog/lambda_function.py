"""Runs every 5 minutes and stops runs and notebook sessions that would
overspend or overstay.

For each run in ACTIVE#RUNS it adds the metered cost so far to an estimate
for jobs still running (elapsed time x rate). A run is stopped when that
reaches the run's maximum cost, or when the owner's month-to-date spend plus
all their running jobs and sessions reaches their monthly limit. runs-events
then settles the run as "stopped".

Sessions in ACTIVE#SESSIONS count towards that limit too (elapsed time x
rate). A session is also stopped once it is past its time limit (it normally
stops itself then; this is the backstop), and one that has waited for the
network for too long is failed. sessions-events settles stopped sessions.
"""
import json
import os
import boto3
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

batch = boto3.client("batch")
ecs = boto3.client("ecs")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
PRICING = json.loads(os.environ["PRICING"])
SESSION_CLUSTER_ARN = os.environ.get("SESSION_CLUSTER_ARN", "")
RATE_BY_CLASS = {"economy": "fargateSpot", "standard": "fargate", "heavy": "ec2"}
TERMINAL = {"completed", "failed", "cancelled", "stopped"}
SESSION_TERMINAL = {"stopped", "failed"}
# How long past its time limit a session may run before it's stopped here.
SESSION_GRACE = timedelta(minutes=5)
# A session waiting this long for the network is failed (the network
# normally comes up in 2-3 minutes).
MAX_WAIT = timedelta(minutes=20)


def handler(event, context):
    table = dynamodb.Table(TABLE)
    now = datetime.now(timezone.utc)
    active = _query(table, "ACTIVE#RUNS", "RUN#")

    runs_by_user = {}
    sessions_by_user = _active_sessions(table, now)
    for row in active:
        run_id = row["sk"][len("RUN#"):]
        run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item")
        if run is None or run["status"] in TERMINAL:
            table.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
            continue
        running = _running_cost(table, run, now)
        runs_by_user.setdefault(run["createdBy"], []).append((run, running))

    period = now.strftime("%Y-%m")
    for user_id in set(runs_by_user) | set(sessions_by_user):
        runs = runs_by_user.get(user_id, [])
        sessions = sessions_by_user.get(user_id, [])
        budget = table.get_item(Key={"pk": f"USER#{user_id}", "sk": "BUDGET"}).get("Item") or {}
        spent = Decimal(budget.get("spentProvisional", 0)) if budget.get("period") == period else Decimal(0)
        limit = Decimal(budget.get("monthlyLimit", "Infinity"))
        over_budget = spent + sum(r for _, r in runs) + sum(r for _, r in sessions) >= limit

        for session, _ in sessions:
            _check_session(table, session, now, over_budget)

        for run, running in runs:
            reason = None
            if Decimal(run.get("costProvisional", 0)) + running >= Decimal(run["maxCost"]):
                reason = "Stopped: reached this run's maximum cost"
            elif over_budget:
                reason = "Stopped: monthly budget reached"
            if reason and not run.get("stopReason") and run.get("batchJobId"):
                _stop(table, run, reason)


def _active_sessions(table, now):
    """{userId: [(session, cost so far)]} for sessions that are open."""
    by_user = {}
    for row in _query(table, "ACTIVE#SESSIONS", "SESSION#"):
        session = table.get_item(Key={"pk": f"SESSION#{row['sk'][len('SESSION#'):]}", "sk": "METADATA"}).get("Item")
        if session is None or session["status"] in SESSION_TERMINAL:
            table.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
            continue
        cost = Decimal(0)
        if session.get("startedAt"):
            rates = PRICING["fargate"]
            hourly = (Decimal(str(rates["vcpuHour"])) * Decimal(session["vcpu"])
                      + Decimal(str(rates["gbHour"])) * Decimal(session["memoryMiB"]) / 1024)
            elapsed = max(0.0, (now - _parse(session["startedAt"])).total_seconds())
            cost = Decimal(str(elapsed)) / 3600 * hourly
        by_user.setdefault(session["createdBy"], []).append((session, cost))
    return by_user


def _check_session(table, session, now, over_budget):
    if session["status"] == "waiting":
        if now - _parse(session["createdAt"]) > MAX_WAIT:
            _fail_waiting(table, session)
        return
    started = session.get("startedAt") or session.get("launchedAt") or session["createdAt"]
    reason = None
    if now - _parse(started) > timedelta(seconds=int(session["maxSeconds"])) + SESSION_GRACE:
        reason = "Stopped: reached its time limit"
    elif over_budget:
        reason = "Stopped: monthly budget reached"
    if not reason or session.get("stopReason") or not session.get("taskArn"):
        return
    try:
        table.update_item(
            Key={"pk": session["pk"], "sk": "METADATA"},
            UpdateExpression="SET stopReason = :r, #st = :s, statusUpdatedAt = :now",
            ConditionExpression="attribute_not_exists(stopReason)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":r": reason, ":s": "stopping", ":now": now.isoformat()},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    ecs.stop_task(cluster=SESSION_CLUSTER_ARN, task=session["taskArn"], reason=reason)
    print(json.dumps({"event": "session_stopped", "sessionId": session["sessionId"], "reason": reason}))


def _fail_waiting(table, session):
    try:
        old = table.update_item(
            Key={"pk": session["pk"], "sk": "METADATA"},
            UpdateExpression="SET #st = :f, statusReason = :r, held = :z, statusUpdatedAt = :now, endedAt = :now "
                             "REMOVE launchSecret",
            ConditionExpression="#st = :w",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":f": "failed", ":w": "waiting", ":z": Decimal(0),
                                       ":r": "The private network didn't come up in time; try again",
                                       ":now": datetime.now(timezone.utc).isoformat()},
            ReturnValues="ALL_OLD",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    if Decimal(old.get("held", 0)) > 0:
        table.update_item(
            Key={"pk": f"USER#{old['createdBy']}", "sk": "BUDGET"},
            UpdateExpression="ADD held :neg, version :one",
            ExpressionAttributeValues={":neg": -Decimal(old["held"]), ":one": 1},
        )
    table.delete_item(Key={"pk": "ACTIVE#SESSIONS", "sk": f"SESSION#{old['sessionId']}"})
    print(json.dumps({"event": "session_wait_failed", "sessionId": old["sessionId"]}))


def _parse(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _running_cost(table, run, now):
    rates = PRICING[RATE_BY_CLASS.get(run["class"], "fargate")]
    hourly = Decimal(str(rates["vcpuHour"])) * Decimal(run["vcpu"]) + Decimal(str(rates["gbHour"])) * Decimal(run["memoryMiB"]) / 1024
    seconds = Decimal(0)
    for child in _query(table, f"RUN#{run['runId']}", "CHILD#"):
        if child.get("status") == "running" and child.get("startedAt"):
            started = datetime.fromisoformat(child["startedAt"])
            seconds += Decimal(max(0.0, (now - started).total_seconds()))
    return seconds / 3600 * hourly


def _stop(table, run, reason):
    table.update_item(
        Key={"pk": f"RUN#{run['runId']}", "sk": "METADATA"},
        UpdateExpression="SET stopReason = :r, statusReason = :r",
        ConditionExpression="attribute_not_exists(stopReason)",
        ExpressionAttributeValues={":r": reason},
    )
    batch.terminate_job(jobId=run["batchJobId"], reason=reason)
    print(json.dumps({"event": "run_stopped", "runId": run["runId"], "reason": reason}))


def _query(table, pk, prefix):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix)}
    while True:
        page = table.query(**kwargs)
        items += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
