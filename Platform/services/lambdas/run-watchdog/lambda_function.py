"""Runs every 5 minutes and stops runs that would overspend.

For each run in ACTIVE#RUNS it adds the metered cost so far to an estimate
for jobs still running (elapsed time x rate). A run is stopped when that
reaches the run's maximum cost, or when the owner's month-to-date spend plus
all their running jobs reaches their monthly limit. runs-events then settles
the run as "stopped".
"""
import json
import os
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key

batch = boto3.client("batch")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
PRICING = json.loads(os.environ["PRICING"])
RATE_BY_CLASS = {"economy": "fargateSpot", "standard": "fargate", "heavy": "ec2"}
TERMINAL = {"completed", "failed", "cancelled", "stopped"}


def handler(event, context):
    table = dynamodb.Table(TABLE)
    now = datetime.now(timezone.utc)
    active = _query(table, "ACTIVE#RUNS", "RUN#")

    runs_by_user = {}
    for row in active:
        run_id = row["sk"][len("RUN#"):]
        run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item")
        if run is None or run["status"] in TERMINAL:
            table.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
            continue
        running = _running_cost(table, run, now)
        runs_by_user.setdefault(run["createdBy"], []).append((run, running))

    period = now.strftime("%Y-%m")
    for user_id, runs in runs_by_user.items():
        budget = table.get_item(Key={"pk": f"USER#{user_id}", "sk": "BUDGET"}).get("Item") or {}
        spent = Decimal(budget.get("spentProvisional", 0)) if budget.get("period") == period else Decimal(0)
        limit = Decimal(budget.get("monthlyLimit", "Infinity"))
        over_budget = spent + sum(r for _, r in runs) >= limit

        for run, running in runs:
            reason = None
            if Decimal(run.get("costProvisional", 0)) + running >= Decimal(run["maxCost"]):
                reason = "Stopped: reached this run's maximum cost"
            elif over_budget:
                reason = "Stopped: monthly budget reached"
            if reason and not run.get("stopReason") and run.get("batchJobId"):
                _stop(table, run, reason)


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
