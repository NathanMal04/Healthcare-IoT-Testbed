"""Provisional metering for Batch jobs and CodeBuild builds.

EventBridge sends every finished job attempt set ("Batch Job State Change",
SUCCEEDED/FAILED, for array children and single jobs) and every finished
build. Each becomes one ledger row:

  USER#{uid} / USAGE#{period}#{source}#{resourceId}#{eventId}

written in the same transaction as the budget's spentProvisional (and, for
jobs, the run's costProvisional). The row is only written if it doesn't
exist yet, so a redelivered event can't bill twice.

Costs use list prices from PRICING; the monthly true-up (a later step)
replaces them with actual cost from the Cost and Usage Report.
"""
import json
import math
import os
import boto3
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

codebuild = boto3.client("codebuild")
dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]
PRICING = json.loads(os.environ["PRICING"])
DEFAULT_MONTHLY_LIMIT = Decimal(os.environ.get("DEFAULT_MONTHLY_LIMIT", "25"))
MIN_BILL_SECONDS = int(PRICING.get("minBillSeconds", 60))
RATE_BY_CLASS = {"economy": "fargateSpot", "standard": "fargate", "heavy": "ec2"}
CENT = Decimal("0.000001")


def handler(event, context):
    if event.get("source") == "aws.codebuild":
        _meter_build(event.get("detail", {}))
    elif event.get("source") == "aws.batch":
        _meter_job(event.get("detail", {}))


def _meter_job(detail):
    if detail.get("status") not in ("SUCCEEDED", "FAILED"):
        return
    array = detail.get("arrayProperties") or {}
    if "size" in array and "index" not in array:
        return  # an array parent does no work of its own

    run_id = _run_id(detail)
    table = dynamodb.Table(TABLE)
    run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item") if run_id else None
    if run is None:
        return

    seconds = 0
    for attempt in detail.get("attempts") or []:
        start, stop = attempt.get("startedAt"), attempt.get("stoppedAt")
        if start and stop:
            seconds += max(MIN_BILL_SECONDS, (stop - start) / 1000)
    if seconds == 0:
        return

    rates = PRICING[RATE_BY_CLASS.get(run["class"], "fargate")]
    hourly = Decimal(str(rates["vcpuHour"])) * Decimal(run["vcpu"]) + Decimal(str(rates["gbHour"])) * Decimal(run["memoryMiB"]) / 1024
    amount = _money(Decimal(str(seconds)) / 3600 * hourly)
    index = array.get("index", 0)
    _record(
        user_id=run["createdBy"],
        period=_period(detail.get("stoppedAt")),
        sk_tail=f"batch#{run_id}#{detail['jobId']}",
        amount=amount,
        details={"resource": f"{run.get('name')} · job {index}", "seconds": Decimal(str(round(seconds, 3))),
                 "runId": run_id, "jobId": detail["jobId"],
                 "costTags": {"userId": run["createdBy"], "runId": run_id}},
        run_key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
    )


def _meter_build(detail):
    if detail.get("build-status") not in ("SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"):
        return
    builds = codebuild.batch_get_builds(ids=[detail["build-id"]]).get("builds", [])
    if not builds:
        return
    build = builds[0]
    env = {v["name"]: v.get("value", "") for v in build.get("environment", {}).get("environmentVariables", [])}
    owner, target = env.get("OWNER_ID"), env.get("TARGET", "")
    start, end = build.get("startTime"), build.get("endTime")
    if not owner or not start or not end:
        return
    minutes = max(1, math.ceil((end - start).total_seconds() / 60))
    amount = _money(Decimal(minutes) * Decimal(str(PRICING["codebuildMinute"])))
    resource_id = target.replace("/", ":") or "build"
    _record(
        user_id=owner,
        period=end.astimezone(timezone.utc).strftime("%Y-%m"),
        sk_tail=f"codebuild#{resource_id}#{build['id']}",
        amount=amount,
        details={"resource": f"Build {target}", "minutes": minutes, "buildId": build["id"],
                 "costTags": {"userId": owner, "resourceId": resource_id}},
    )


def _record(user_id, period, sk_tail, amount, details, run_key=None):
    ledger = {
        "pk": f"USER#{user_id}", "sk": f"USAGE#{period}#{sk_tail}", "entity": "usage", "kind": "provisional",
        "period": period, "amount": amount, "recordedAt": _now(), **details,
    }
    for attempt in range(3):
        items = [{"Put": {"TableName": TABLE, "Item": _ser(ledger), "ConditionExpression": "attribute_not_exists(sk)"}}]
        if run_key:
            items.append({"Update": {
                "TableName": TABLE, "Key": _ser(run_key),
                "UpdateExpression": "ADD costProvisional :c", "ExpressionAttributeValues": _ser({":c": amount}),
            }})
        # Only the current month counts against the budget; a late event for
        # a closed month still gets its ledger row.
        if period == _period():
            items.append({"Update": {
                "TableName": TABLE, "Key": _ser({"pk": f"USER#{user_id}", "sk": "BUDGET"}),
                "UpdateExpression": "ADD spentProvisional :c, version :one",
                "ConditionExpression": "#p = :p",
                "ExpressionAttributeNames": {"#p": "period"},
                "ExpressionAttributeValues": _ser({":c": amount, ":one": 1, ":p": period}),
            }})
        try:
            client.transact_write_items(TransactItems=items)
            return
        except ClientError as e:
            if e.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = e.response.get("CancellationReasons", [])
            if reasons and reasons[0].get("Code") == "ConditionalCheckFailed":
                return  # already recorded
            if reasons and reasons[-1].get("Code") == "ConditionalCheckFailed" and period == _period():
                _roll_budget(user_id, period)
                continue
            raise
    raise RuntimeError(f"Could not record usage {ledger['sk']}")


def _roll_budget(user_id, period):
    """Creates the budget, or moves it to a new month (spend resets; open
    holds carry over)."""
    table = dynamodb.Table(TABLE)
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    try:
        table.update_item(
            Key=key,
            UpdateExpression=(
                "SET #p = :p, spentProvisional = :zero, entity = :e, "
                "monthlyLimit = if_not_exists(monthlyLimit, :limit), held = if_not_exists(held, :zero), "
                "heavyEnabled = if_not_exists(heavyEnabled, :false), updatedAt = :now ADD version :one"
            ),
            ConditionExpression="attribute_not_exists(#p) OR #p < :p",
            ExpressionAttributeNames={"#p": "period"},
            ExpressionAttributeValues={":p": period, ":zero": Decimal(0), ":e": "budget", ":limit": DEFAULT_MONTHLY_LIMIT,
                                       ":false": False, ":now": _now(), ":one": 1},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _run_id(detail):
    for var in (detail.get("container") or {}).get("environment", []):
        if var.get("name") == "RUN_ID":
            return var.get("value")
    return (detail.get("tags") or {}).get("runId")


def _period(millis=None):
    moment = datetime.fromtimestamp(millis / 1000, tz=timezone.utc) if millis else datetime.now(timezone.utc)
    return moment.strftime("%Y-%m")


def _money(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _ser(values):
    return {k: serializer.serialize(v) for k, v in values.items()}


def _now():
    return datetime.now(timezone.utc).isoformat()
