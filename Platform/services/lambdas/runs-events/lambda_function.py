"""EventBridge target for Batch "Job State Change" events on the run queues.

Keeps each job's CHILD# row and the run's status current, and settles a
finished run: final status, budget hold released, run removed from the
watchdog's list, and a MODULE#/RUN# history row written for future cost
estimates. Every write only moves status forward, so late or repeated
events are harmless.
"""
import json
import os
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]

CHILD_STATUS = {
    "SUBMITTED": ("queued", 1), "PENDING": ("queued", 1), "RUNNABLE": ("queued", 1), "STARTING": ("queued", 1),
    "RUNNING": ("running", 2), "SUCCEEDED": ("succeeded", 3), "FAILED": ("failed", 3),
}
ACTIVE = ("pending", "queued", "running")


def handler(event, context):
    detail = event.get("detail", {})
    run_id = run_id_of(detail)
    if not run_id:
        print(json.dumps({"event": "job_without_run", "jobId": detail.get("jobId")}))
        return

    table = dynamodb.Table(TABLE)
    array = detail.get("arrayProperties") or {}
    is_child = "index" in array
    is_parent = "size" in array and not is_child
    status = detail.get("status")

    if not is_parent:
        _update_child(table, run_id, int(array.get("index", 0)), detail)

    if is_parent or not array:
        if status in ("STARTING", "RUNNING"):
            _mark_running(table, run_id)
        elif status in ("SUCCEEDED", "FAILED"):
            finalize(table, run_id, status, detail.get("statusReason"))
    elif is_child and status == "RUNNING":
        _mark_running(table, run_id)


def run_id_of(detail):
    for var in (detail.get("container") or {}).get("environment", []):
        if var.get("name") == "RUN_ID":
            return var.get("value")
    tags = detail.get("tags") or {}
    if tags.get("runId"):
        return tags["runId"]
    name = detail.get("jobName", "")
    return name[4:] if name.startswith("run-") else None


def _update_child(table, run_id, index, detail):
    status, rank = CHILD_STATUS.get(detail.get("status"), ("queued", 1))
    attempts = detail.get("attempts") or []
    log_stream = (detail.get("container") or {}).get("logStreamName")
    if not log_stream and attempts:
        log_stream = (attempts[-1].get("container") or {}).get("logStreamName")

    assignments = ["#st = :s", "statusRank = :rank", "attempts = :attempts", "updatedAt = :now"]
    values = {":s": status, ":rank": rank, ":attempts": len(attempts), ":now": _now()}
    for field, value in (("logStreamName", log_stream), ("statusReason", detail.get("statusReason")),
                         ("startedAt", _iso(detail.get("startedAt"))), ("stoppedAt", _iso(detail.get("stoppedAt")))):
        if value:
            assignments.append(f"{field} = :{field}")
            values[f":{field}"] = value
    try:
        table.update_item(
            Key={"pk": f"RUN#{run_id}", "sk": f"CHILD#{index:05d}"},
            UpdateExpression="SET " + ", ".join(assignments),
            # Equal rank still updates (a retried attempt's new log stream),
            # but a job never goes back from running or finished.
            ConditionExpression="attribute_exists(pk) AND (attribute_not_exists(statusRank) OR statusRank <= :rank)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues=values,
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _mark_running(table, run_id):
    try:
        table.update_item(
            Key={"pk": f"RUN#{run_id}", "sk": "METADATA"},
            UpdateExpression="SET #st = :r, startedAt = if_not_exists(startedAt, :now), statusUpdatedAt = :now",
            ConditionExpression="#st IN (:p, :q)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":r": "running", ":p": "pending", ":q": "queued", ":now": _now()},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def finalize(table, run_id, batch_status, batch_reason):
    run = table.get_item(Key={"pk": f"RUN#{run_id}", "sk": "METADATA"}).get("Item")
    if run is None or run["status"] not in ACTIVE:
        return

    if run.get("stopReason"):
        final, reason = "stopped", run["stopReason"]
    elif run.get("cancelRequested"):
        final, reason = "cancelled", "Cancelled by user"
    elif batch_status == "SUCCEEDED":
        final, reason = "completed", None
    else:
        final, reason = "failed", batch_reason or "One or more jobs failed"

    now = _now()
    held = Decimal(run.get("held", 0))
    update = "SET #st = :final, endedAt = :now, statusUpdatedAt = :now, held = :zero"
    values = {":final": final, ":now": now, ":zero": Decimal(0), ":p": "pending", ":q": "queued", ":r": "running"}
    if reason:
        update += ", statusReason = :reason"
        values[":reason"] = reason

    items = [
        {"Update": {
            "TableName": TABLE, "Key": _ser({"pk": f"RUN#{run_id}", "sk": "METADATA"}),
            "UpdateExpression": update, "ConditionExpression": "#st IN (:p, :q, :r)",
            "ExpressionAttributeNames": {"#st": "status"}, "ExpressionAttributeValues": _ser(values),
        }},
        {"Delete": {"TableName": TABLE, "Key": _ser({"pk": "ACTIVE#RUNS", "sk": f"RUN#{run_id}"})}},
    ]
    if held > 0:
        items.append({"Update": {
            "TableName": TABLE, "Key": _ser({"pk": f"USER#{run['createdBy']}", "sk": "BUDGET"}),
            "UpdateExpression": "ADD held :neg, version :one",
            "ExpressionAttributeValues": _ser({":neg": -held, ":one": 1}),
        }})
    try:
        client.transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            return  # another event finalized it first
        raise

    children = _query(table, f"RUN#{run_id}", "CHILD#")
    seconds = sum(_duration(c) for c in children)
    table.put_item(Item={
        "pk": f"MODULE#{run['moduleId']}", "sk": f"RUN#{run_id}", "entity": "module-run",
        "moduleVersion": run["moduleVersion"], "status": final, "class": run["class"], "size": run["size"],
        "childCount": run["childCount"], "unitCount": run["unitCount"],
        "unitSeconds": Decimal(str(round(seconds, 3))), "createdAt": run["createdAt"], "endedAt": now,
    })


def _duration(child):
    try:
        start = datetime.fromisoformat(child["startedAt"])
        stop = datetime.fromisoformat(child["stoppedAt"])
    except (KeyError, TypeError, ValueError):
        return 0
    return max(0.0, (stop - start).total_seconds())


def _query(table, pk, prefix):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix)}
    while True:
        page = table.query(**kwargs)
        items += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _iso(millis):
    if not millis:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()


def _ser(values):
    return {k: serializer.serialize(v) for k, v in values.items()}


def _now():
    return datetime.now(timezone.utc).isoformat()
