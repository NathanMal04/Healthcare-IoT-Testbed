#!/usr/bin/env python3
"""Sets a user's monthly spending limit and whether they may use the Heavy class.

  python3 set_budget.py --table healthcare-iot-testbed-dev-metadata --user-id <cognito sub> \\
      [--monthly-limit 100] [--heavy on|off]

The user id is the Cognito `sub` (the userId in the users table). Omitted
options are left as they are; a user with no budget yet gets the defaults
first ($25, Heavy off).
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal

import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--monthly-limit", type=Decimal)
    parser.add_argument("--heavy", choices=["on", "off"])
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile")
    args = parser.parse_args()
    if args.monthly_limit is None and args.heavy is None:
        parser.error("nothing to change: pass --monthly-limit and/or --heavy")

    table = boto3.Session(profile_name=args.profile, region_name=args.region).resource("dynamodb").Table(args.table)
    now = datetime.now(timezone.utc)
    sets = [
        "entity = :e", "updatedAt = :now",
        "held = if_not_exists(held, :zero)", "spentProvisional = if_not_exists(spentProvisional, :zero)",
        "#p = if_not_exists(#p, :period)",
    ]
    values = {":e": "budget", ":now": now.isoformat(), ":zero": Decimal(0), ":period": now.strftime("%Y-%m"), ":one": 1}
    sets.append("monthlyLimit = :limit" if args.monthly_limit is not None else "monthlyLimit = if_not_exists(monthlyLimit, :limit)")
    values[":limit"] = args.monthly_limit if args.monthly_limit is not None else Decimal(25)
    sets.append("heavyEnabled = :heavy" if args.heavy else "heavyEnabled = if_not_exists(heavyEnabled, :heavy)")
    values[":heavy"] = args.heavy == "on"

    item = table.update_item(
        Key={"pk": f"USER#{args.user_id}", "sk": "BUDGET"},
        UpdateExpression="SET " + ", ".join(sets) + " ADD version :one",
        ExpressionAttributeNames={"#p": "period"},
        ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )["Attributes"]
    print(f"monthlyLimit={item['monthlyLimit']} heavyEnabled={item['heavyEnabled']} "
          f"spent={item['spentProvisional']} held={item['held']} period={item['period']}")


if __name__ == "__main__":
    main()
