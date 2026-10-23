"""GET /usage?period=YYYY-MM: the caller's budget and usage ledger for a month."""
import json
import os
import re
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
DEFAULT_MONTHLY_LIMIT = Decimal(os.environ.get("DEFAULT_MONTHLY_LIMIT", "25"))
PERIOD_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_ROWS = 2000


def handler(event, context):
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    params = event.get("queryStringParameters") or {}
    current = datetime.now(timezone.utc).strftime("%Y-%m")
    period = params.get("period") or current
    if not PERIOD_PATTERN.match(period):
        return _resp(400, {"error": "period must look like 2026-09"})

    table = dynamodb.Table(TABLE)
    budget = _budget(table, user_id, current)

    rows, kwargs = [], {
        "KeyConditionExpression": Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with(f"USAGE#{period}#"),
        "ScanIndexForward": False,
    }
    while len(rows) < MAX_ROWS:
        page = table.query(**kwargs)
        rows += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    totals = {}
    for row in rows:
        source = row["sk"].split("#")[2]
        totals[source] = totals.get(source, Decimal(0)) + Decimal(row.get("amount", 0))

    spent = budget["spentProvisional"] if budget.get("period") == current else Decimal(0)
    return _resp(200, {
        "period": period,
        "budget": {
            "monthlyLimit": budget["monthlyLimit"], "spent": spent, "held": budget["held"],
            "available": budget["monthlyLimit"] - spent - budget["held"],
            "heavyEnabled": bool(budget.get("heavyEnabled")),
        },
        "totals": totals,
        "total": sum(totals.values(), Decimal(0)),
        "entries": [{
            "source": row["sk"].split("#")[2], "kind": row.get("kind"), "amount": row.get("amount"),
            "resource": row.get("resource"), "seconds": row.get("seconds"), "minutes": row.get("minutes"),
            "runId": row.get("runId"), "recordedAt": row.get("recordedAt"),
        } for row in rows],
        "truncated": len(rows) >= MAX_ROWS,
    })


def _budget(table, user_id, period):
    key = {"pk": f"USER#{user_id}", "sk": "BUDGET"}
    item = table.get_item(Key=key).get("Item")
    if item is not None:
        return item
    default = {**key, "entity": "budget", "monthlyLimit": DEFAULT_MONTHLY_LIMIT, "held": Decimal(0),
               "spentProvisional": Decimal(0), "period": period, "heavyEnabled": False, "version": 0,
               "updatedAt": datetime.now(timezone.utc).isoformat()}
    try:
        table.put_item(Item=default, ConditionExpression="attribute_not_exists(pk)")
        return default
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        return table.get_item(Key=key)["Item"]


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    raise TypeError(type(value))


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body, default=_plain),
    }
